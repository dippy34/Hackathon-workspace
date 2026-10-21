import { CONFIG, type NightTuning, type ThreatId } from '../config.js';
import { Attack } from './attack.js';
import { TIME_EPS } from './math.js';
import {
  effectiveCaughtAfterSec,
  handsBusySec,
  isTeachingThreat,
  passesFairness,
  sampleFirstDueSec,
  sampleGapSec,
  sampleTeachingStartSec,
} from './scheduler.js';
import type { AttackView, CounteringFn, NightEvents, NightRunnerLike, NightState, Rng } from './types.js';

/**
 * Largest simulation step. Longer frames (a 1 s hitch) are split into equal
 * substeps no longer than this, so starts, leaves and catches happen at the
 * right moments instead of all at once at the end of the frame.
 */
export const MAX_SUBSTEP_SEC = 1 / 30;

/**
 * Longest frame the night clock accepts. A longer frame (a hitch) is clamped
 * to this, so night time slows down during the hitch instead of jumping. The
 * player's input is sampled once per frame, so without the clamp a 1 s hitch
 * could start an attack and catch the player inside a single update(), with no
 * rendered frame ever showing the warning. 0.1 s is below every effective
 * "caught after" in the shipped table (the shortest is the Listener's
 * 0.3 s / 1.6 = 0.19 s on night 5). Engine robustness constant, not game tuning.
 */
export const MAX_FRAME_SEC = 0.1;

type Block = 'max concurrent' | 'teaching alone' | 'closing' | 'fairness' | null;

interface Slot {
  readonly id: ThreatId;
  /** Night-clock second the next attack is due; Infinity = not scheduled (active, or a later teaching attack waiting its turn). */
  due: number;
  attack: Attack | null;
  /** Substep number in which this slot was last considered for a start. */
  seen: number;
}

const NEVER_COUNTERING: CounteringFn = () => false;

/**
 * Runs one night: the clock, every threat's attacks, and the scheduler rules
 * (DESIGN.md "Fairness rules" and "The nights").
 *
 * Scheduling:
 * - Every threat in `tuning.threats` has its own due time on the night clock.
 *   Gaps are (avgGapSec / aggression) x U[gapJitterMin, gapJitterMax]; after an
 *   attack leaves, that threat is next due one fresh gap later.
 * - Teaching: a threat teaches on the night it is introduced
 *   (`introducedOnNight(id) === tuning.night`), and its FIRST attack that
 *   night is the teaching attack. It is due at U[teachingStartEarliestSec,
 *   teachingStartWithinSec - 0.5] and always attacks alone: nothing else may
 *   start before it has started, nor while it is active, so it starts the
 *   moment it is due. Non-teaching threats wait (stay due) until every
 *   teaching attack of the night has finished. If several threats are
 *   introduced on the same night their teaching attacks run one after another
 *   in `tuning.threats` order, each due a fresh teaching offset after the
 *   previous one left.
 * - Non-teaching threats are first due at max(quietOpeningSec, one gap).
 * - A due threat starts only if: fewer than `maxConcurrent` attacks are active
 *   (the Listener counts), the teaching rule allows it, the clock is not inside
 *   the quiet closing, and it passes the fairness rule (`passesFairness`, the
 *   DESIGN.md rule generalised to a sum over 2+ active hands-attacks).
 *   Otherwise it keeps waiting with its due time unchanged (never re-rolled).
 *   Several due threats are considered earliest-due first (ties: tuning order),
 *   each start tightening the checks for the next.
 *
 * Fairness also budgets one more reaction while no active hands-attack is
 * being countered yet, and a short hand-off right after one leaves (see
 * `handsBusySec` in scheduler.ts).
 *
 * Frames longer than MAX_FRAME_SEC are clamped to it (night time slows during a
 * hitch), then split into substeps of at most MAX_SUBSTEP_SEC.
 *
 * Each substep: advance clock -> update active attacks -> any caught? end
 * night (onCaught once) -> retire attacks that left (onAttackLeave, schedule
 * next) -> clock over? survived (remaining attacks dropped silently,
 * onSurvived once) -> start due attacks (onAttackStart). Once caught or
 * survived the runner never changes again.
 */
export class NightRunner implements NightRunnerLike {
  readonly tuning: NightTuning;
  private readonly rng: Rng;
  private readonly events: NightEvents;
  private readonly slots: Slot[];
  /** Slots of threats introduced tonight, in tuning order; the first `teachingDone` have finished teaching. */
  private readonly teachingQueue: Slot[];
  private teachingDone = 0;
  private readonly active: Attack[] = [];
  /** Scratch buffer for attacks retired in one substep (reused, never reallocated). */
  private readonly retired: Attack[] = [];
  private _state: NightState = 'running';
  private _elapsed = 0;
  private substep = 0;
  /** Night-clock second the most recent hands-attack left (fairness hand-off budget). */
  private lastHandsLeaveAt = -Infinity;
  /** Set by dispose(): the runner is frozen and fires no more events. */
  private disposed = false;

  constructor(tuning: NightTuning, rng: Rng, events: NightEvents = {}) {
    this.tuning = tuning;
    this.rng = rng;
    this.events = events;
    this.slots = tuning.threats.map((id) => ({ id, due: Infinity, attack: null, seen: -1 }));
    this.teachingQueue = this.slots.filter((s) => isTeachingThreat(s.id, tuning.night));
    for (const s of this.slots) {
      if (s === this.teachingQueue[0]) s.due = sampleTeachingStartSec(rng);
      else if (!this.teachingQueue.includes(s)) s.due = sampleFirstDueSec(s.id, tuning.aggression, rng);
    }
  }

  get state(): NightState {
    return this._state;
  }
  get elapsedSec(): number {
    return this._elapsed;
  }
  get remainingSec(): number {
    return Math.max(0, this.tuning.lengthSec - this._elapsed);
  }

  /** Live view of the attacks in progress. Reused between updates: copy it to keep a snapshot. */
  activeAttacks(): readonly AttackView[] {
    return this.active;
  }

  /** Seconds until the threat's next attack is due (negative = due but held back); null if active, unscheduled or not in tonight's roster. */
  nextAttackInSec(id: ThreatId): number | null {
    const s = this.slotOf(id);
    if (!s || s.attack || !Number.isFinite(s.due)) return null;
    return s.due - this._elapsed;
  }

  blockedReason(id: ThreatId): string | null {
    const s = this.slotOf(id);
    if (!s || s.attack || this._state !== 'running' || s.due > this._elapsed + TIME_EPS) return null;
    const block = this.blockOf(s);
    if (block !== 'fairness') return block;
    const need = handsBusySec(this.active, this._elapsed - this.lastHandsLeaveAt);
    const has = effectiveCaughtAfterSec(id, this.tuning.aggression);
    return `fairness: needs ${need.toFixed(1)}s > ${has.toFixed(1)}s`;
  }

  /**
   * Advances the night by one frame. `dtSec` is clamped to MAX_FRAME_SEC and
   * split into substeps of at most MAX_SUBSTEP_SEC; `countering` is asked
   * every substep.
   */
  update(dtSec: number, countering: CounteringFn = NEVER_COUNTERING): void {
    if (this._state !== 'running' || this.disposed || !(dtSec > 0)) return;
    const dt = Math.min(dtSec, MAX_FRAME_SEC);
    const n = Math.max(1, Math.ceil(dt / MAX_SUBSTEP_SEC - 1e-9));
    const h = dt / n;
    for (let i = 0; i < n && this._state === 'running' && !this.disposed; i++) this.step(h, countering);
  }

  /**
   * Abandons the night (GameFlow calls this when it replaces the runner, e.g.
   * a debug jump from inside an event handler). From then on update() is a
   * no-op and no further events fire, even for the rest of the update() that
   * is running right now. `state` keeps its last value.
   */
  dispose(): void {
    this.disposed = true;
  }

  private step(h: number, countering: CounteringFn): void {
    const active = this.active;
    // (1) clock
    this._elapsed += h;
    const now = this._elapsed;
    // (2) meters
    for (let i = 0; i < active.length; i++) {
      const a = active[i];
      a.update(h, countering(a.id));
    }
    // (3) caught ends the night
    for (let i = 0; i < active.length; i++) {
      if (active[i].state === 'caught') {
        this.endCaught(active[i]);
        return;
      }
    }
    // (4) retire attacks that left
    this.retireLeft(now);
    if (this.disposed) return; // an onAttackLeave handler abandoned the night
    // (5) clock ran out
    if (now >= this.tuning.lengthSec - TIME_EPS) {
      this.endSurvived();
      return;
    }
    // (6) start due attacks
    this.startDue(now);
  }

  private endCaught(attack: Attack): void {
    this._state = 'caught';
    // activeAttacks() only lists state === 'active'; the others stay frozen in place.
    this.compactActive();
    this.events.onCaught?.(attack);
  }

  private endSurvived(): void {
    this._state = 'survived';
    this._elapsed = this.tuning.lengthSec;
    for (let i = 0; i < this.active.length; i++) this.slotOf(this.active[i].id)!.attack = null;
    this.active.length = 0;
    this.events.onSurvived?.();
  }

  private retireLeft(now: number): void {
    const retired = this.retired;
    retired.length = 0;
    this.compactActive(retired);
    if (retired.length === 0) return;
    for (let i = 0; i < retired.length; i++) {
      const a = retired[i];
      const s = this.slotOf(a.id)!;
      s.attack = null;
      s.due = now + sampleGapSec(a.id, this.tuning.aggression, this.rng);
      if (CONFIG.threats[a.id].usesHands) this.lastHandsLeaveAt = now;
      if (a.teaching) {
        const next = this.teachingQueue[++this.teachingDone];
        if (next) next.due = now + sampleTeachingStartSec(this.rng);
      }
    }
    for (let i = 0; i < retired.length && !this.disposed; i++) this.events.onAttackLeave?.(retired[i]);
    retired.length = 0;
  }

  /** Drops non-active attacks from `active` in place, optionally collecting them. */
  private compactActive(out?: Attack[]): void {
    const active = this.active;
    let w = 0;
    for (let r = 0; r < active.length; r++) {
      const a = active[r];
      if (a.state === 'active') active[w++] = a;
      else out?.push(a);
    }
    active.length = w;
  }

  private startDue(now: number): void {
    const stamp = ++this.substep;
    const slots = this.slots;
    // An onAttackStart handler may dispose the runner; stop starting at once.
    while (!this.disposed) {
      let pick: Slot | null = null;
      for (let i = 0; i < slots.length; i++) {
        const s = slots[i];
        if (s.attack || s.seen === stamp || s.due > now + TIME_EPS) continue;
        if (!pick || s.due < pick.due) pick = s; // strict <: ties keep tuning order
      }
      if (!pick) return;
      pick.seen = stamp;
      if (this.blockOf(pick) === null) this.start(pick);
    }
  }

  private start(s: Slot): void {
    const teaching = this.teachingDone < this.teachingQueue.length && s === this.teachingQueue[this.teachingDone];
    const attack = new Attack(s.id, CONFIG.threats[s.id], this.tuning.aggression, teaching);
    s.attack = attack;
    s.due = Infinity;
    this.active.push(attack);
    this.events.onAttackStart?.(attack);
  }

  /** Why a due, idle slot may not start right now (null = it may). */
  private blockOf(s: Slot): Block {
    const active = this.active;
    if (active.length >= this.tuning.maxConcurrent) return 'max concurrent';
    if (
      this.teachingDone < this.teachingQueue.length &&
      (s !== this.teachingQueue[this.teachingDone] || active.length > 0)
    ) {
      return 'teaching alone';
    }
    if (this._elapsed > this.tuning.lengthSec - CONFIG.scheduler.quietClosingSec) return 'closing';
    if (!passesFairness(s.id, this.tuning.aggression, active, this._elapsed - this.lastHandsLeaveAt)) return 'fairness';
    return null;
  }

  private slotOf(id: ThreatId): Slot | undefined {
    const slots = this.slots;
    for (let i = 0; i < slots.length; i++) if (slots[i].id === id) return slots[i];
    return undefined;
  }
}
