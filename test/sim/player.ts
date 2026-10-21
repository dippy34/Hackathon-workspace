/**
 * Simulation harness for the rules engine: player models plus a driver that
 * runs one whole night through NightRunner and records what happened.
 *
 * Nothing here knows how the scheduler is implemented. Everything is observed
 * through the public NightRunnerLike / AttackView contracts and NightEvents,
 * so the same harness checks any implementation of src/core/night-runner.ts.
 */

import { CONFIG, nightTuning, type NightTuning, type ThreatId } from '../../src/config.js';
import { NightRunner } from '../../src/core/night-runner.js';
import { mulberry32 } from '../../src/core/rng.js';
import type {
  AttackView,
  CounteringFn,
  NightRunnerLike,
  NightState,
} from '../../src/core/types.js';

/** The headset's frame time: the simulation steps at 72 Hz like a Quest 3. */
export const SIM_DT = 1 / 72;

/** Float slack for comparisons that the spec states exactly. */
export const EPS = 1e-6;

// ─── Player models ──────────────────────────────────────────────────────────

/** Anything that can decide, frame by frame, which threats the player counters. */
export interface PlayerModel {
  /**
   * Called once per frame, before runner.update(), with the runner as it is at
   * the start of the frame. Returns the countering answers for that frame.
   */
  plan(runner: NightRunnerLike): CounteringFn;
}

/** Never counters anything (sits still in the wrong way). */
export const neverCounters: PlayerModel = { plan: () => () => false };

/** An oracle that counters every threat from the first frame of its attack. */
export const alwaysCounters: PlayerModel = { plan: () => () => true };

/** An oracle that counters every threat except `x`, which it ignores entirely. */
export function countersAllExcept(x: ThreatId): PlayerModel {
  return { plan: () => (id) => id !== x };
}

/**
 * Hands each counter occupies (DESIGN.md "Fairness rules" table):
 * Under the Desk = both hands flat, Peeker = one hand on the flashlight,
 * Knocker = one palm out, Listener = no hands (it only needs silence).
 */
export const HANDS_NEEDED: Readonly<Record<ThreatId, 0 | 1 | 2>> = {
  underDesk: 2,
  peeker: 1,
  knocker: 1,
  listener: 0,
};

/** Where a hand has to be to counter each threat. Resting hands lie flat on the desk. */
type Station = 'desk' | 'window' | 'door';
const STATION_OF: Readonly<Record<ThreatId, Station>> = {
  underDesk: 'desk',
  peeker: 'window',
  knocker: 'door',
  listener: 'desk',
};

interface Hand {
  /** Where the hand is, or is heading. */
  station: Station;
  /** Elapsed night time at which the hand arrives at `station`. */
  arriveAt: number;
  /** The attack this hand is committed to, if any. */
  task: AttackView | null;
}

export interface IdealPlayerOptions {
  /** Seconds from an attack's start before the player notices it and acts. */
  reactionSec?: number;
  /** Seconds a hand needs to move from one task (place) to another. */
  moveSec?: number;
}

/**
 * The "ideal human" used by the fairness simulation. If the scheduler keeps
 * the DESIGN.md promise ("the game never starts an attack that can't be
 * survived"), this player is never caught.
 *
 * Model:
 * - Two hands. A hand counters a threat only once it is at that threat's
 *   place (desk / window / door). Moving a hand to a different place takes
 *   `moveSec` (0.3 s). Idle hands go back to resting flat on the desk, which is
 *   also where Under the Desk is countered; that is the posture the intro
 *   teaches ("Put both hands flat on your desk").
 * - Reaction: an attack is invisible to the player for its first
 *   `reactionSec` (0.8 s). Only then can hands be sent to it, so a hand that is
 *   not already in place counters at the earliest 0.8 + 0.3 s after the start.
 * - Hands: Under the Desk needs BOTH hands, Peeker ONE, Knocker ONE.
 * - The Listener needs no hands. The player is always quiet, so the Listener is
 *   countered from its first frame. (Its "caught after" is 0.3 s / aggression,
 *   shorter than any reaction time; DESIGN.md's counter is a state the player
 *   is already in, not an action they react with.)
 * - Each frame the player assigns free hands greedily to the noticed
 *   hands-attacks in order of urgency, least time until caught first:
 *   (1 - meter) * caughtAfterSec / aggression. An attack needing more hands
 *   than are free waits.
 * - Commitment: hands that are on an attack stay on it until it leaves. An
 *   ideal player finishes the counter they started instead of thrashing
 *   between tasks; re-planning mid-counter only adds 0.3 s moves.
 */
export class IdealPlayer implements PlayerModel {
  readonly reactionSec: number;
  readonly moveSec: number;
  private readonly hands: Hand[] = [
    { station: 'desk', arriveAt: 0, task: null },
    { station: 'desk', arriveAt: 0, task: null },
  ];

  constructor(opts: IdealPlayerOptions = {}) {
    this.reactionSec = opts.reactionSec ?? 0.8;
    this.moveSec = opts.moveSec ?? 0.3;
  }

  plan(runner: NightRunnerLike): CounteringFn {
    const now = runner.elapsedSec;
    const aggression = runner.tuning.aggression;
    const active = runner.activeAttacks();

    // 1. Hands whose attack is over go back to resting flat on the desk.
    for (const h of this.hands) {
      if (h.task && !active.includes(h.task)) {
        h.task = null;
        this.moveTo(h, 'desk', now);
      }
    }

    // 2. Noticed hands-attacks that have no hands yet, most urgent first.
    const unserved = active
      .filter(
        (a) =>
          HANDS_NEEDED[a.id] > 0 &&
          a.ageSec >= this.reactionSec - 1e-9 &&
          !this.hands.some((h) => h.task === a),
      )
      .sort((a, b) => urgencySec(a, aggression) - urgencySec(b, aggression));

    for (const a of unserved) {
      const need = HANDS_NEEDED[a.id];
      const station = STATION_OF[a.id];
      const free = this.hands.filter((h) => h.task === null);
      if (free.length < need) continue;
      // Prefer hands that are already there (or on their way there).
      free.sort((x, y) => Number(x.station !== station) - Number(y.station !== station));
      for (const h of free.slice(0, need)) {
        h.task = a;
        this.moveTo(h, station, now);
      }
    }

    // 3. Who is actually countered during this frame.
    const countered = new Set<ThreatId>();
    for (const a of active) {
      const need = HANDS_NEEDED[a.id];
      if (need === 0) {
        countered.add(a.id); // always quiet
        continue;
      }
      const mine = this.hands.filter((h) => h.task === a);
      if (mine.length >= need && mine.every((h) => h.arriveAt <= now + 1e-9)) countered.add(a.id);
    }
    return (id) => countered.has(id);
  }

  private moveTo(h: Hand, station: Station, now: number): void {
    if (h.station === station) return; // already there or already heading there
    h.station = station;
    h.arriveAt = now + this.moveSec;
  }
}

/** Seconds until this attack catches the player if it gets no counter from now on. */
export function urgencySec(a: AttackView, aggression: number): number {
  return ((1 - a.meter) * CONFIG.threats[a.id].caughtAfterSec) / aggression;
}

// ─── Night driver ───────────────────────────────────────────────────────────

/** A snapshot of another attack that was active when an attack started. */
export interface ActiveSnapshot {
  id: ThreatId;
  teaching: boolean;
  remainingLeaveSec: number;
}

export interface StartRecord {
  /** Index of this start within the night (0 = first attack). */
  index: number;
  id: ThreatId;
  teaching: boolean;
  /** runner.elapsedSec at the moment onAttackStart fired. */
  atSec: number;
  /** Attacks already active when this one started (snapshotted at that moment). */
  others: ActiveSnapshot[];
  /** The new attack's own fields at start (should be a fresh meter). */
  fresh: { state: string; meter: number; counteredSec: number; ageSec: number };
}

export interface LeaveRecord {
  id: ThreatId;
  teaching: boolean;
  atSec: number;
  ageSec: number;
  counteredSec: number;
  /** Seconds from the leave until this threat's next due time (null if not observable). */
  gapSec: number | null;
}

export interface CaughtRecord {
  id: ThreatId;
  teaching: boolean;
  atSec: number;
  ageSec: number;
  meter: number;
}

export interface NightLog {
  night: number;
  seed: number;
  tuning: NightTuning;
  outcome: NightState;
  elapsedSec: number;
  frames: number;
  starts: StartRecord[];
  leaves: LeaveRecord[];
  caught: CaughtRecord | null;
  survivedFired: number;
  caughtFired: number;
  /** nextAttackInSec(id) for every threat before the first update. */
  initialDue: Record<ThreatId, number | null>;
  /** Highest number of simultaneous attacks seen right after a start. */
  maxConcurrentSeen: number;
  /** The highest meter any attack reached (closest call). */
  peakMeter: { value: number; id: ThreatId | null; atSec: number };
  /** runner.activeAttacks().length once the night is over (survived must drop them all). */
  activeAtEnd: number;
  /** Events after onCaught/onSurvived, or clock movement after the night ended (should all be zero). */
  afterEnd: { events: number; elapsedDelta: number; stateChanged: boolean };
}

export interface RunNightOptions {
  night: number;
  seed: number;
  /** Override the night's tuning (stress tests); defaults to nightTuning(night). */
  tuning?: NightTuning;
  player: PlayerModel;
  /** Frame time passed to runner.update (default SIM_DT). */
  dt?: number;
  /** Called after every frame (for per-frame invariant checks). */
  onFrame?: (runner: NightRunnerLike, liveAttacks: readonly AttackView[]) => void;
}

/** Seed offset per night so the five nights never share an RNG stream. */
export function nightSeed(night: number, seed: number): number {
  return (night * 100_003 + seed * 7_919 + 17) >>> 0;
}

/**
 * Runs one night from its first frame until it is caught or survived, driving
 * NightRunner directly, and records every event.
 *
 * Besides the runner's own activeAttacks(), the driver keeps its own list of
 * live attacks built only from events (start adds, leave removes). Snapshots
 * of "what was active when X started" come from that list, so they reflect
 * the state X was checked against even if two attacks start in one frame.
 */
export function runNight(opts: RunNightOptions): NightLog {
  const tuning = opts.tuning ?? nightTuning(opts.night);
  const dt = opts.dt ?? SIM_DT;
  const live: AttackView[] = [];
  const starts: StartRecord[] = [];
  const leaves: LeaveRecord[] = [];
  const pendingGap: LeaveRecord[] = [];
  let caught: CaughtRecord | null = null;
  let survivedFired = 0;
  let caughtFired = 0;
  let maxConcurrentSeen = 0;
  let ended = false;
  let eventsAfterEnd = 0;

  const runner: NightRunner = new NightRunner(tuning, mulberry32(nightSeed(opts.night, opts.seed)), {
    onAttackStart(a) {
      if (ended) eventsAfterEnd++;
      const others = live.filter((x) => x !== a);
      starts.push({
        index: starts.length,
        id: a.id,
        teaching: a.teaching,
        atSec: runner.elapsedSec,
        others: others.map((o) => ({ id: o.id, teaching: o.teaching, remainingLeaveSec: o.remainingLeaveSec })),
        fresh: { state: a.state, meter: a.meter, counteredSec: a.counteredSec, ageSec: a.ageSec },
      });
      if (!live.includes(a)) live.push(a);
      maxConcurrentSeen = Math.max(maxConcurrentSeen, live.length);
    },
    onAttackLeave(a) {
      if (ended) eventsAfterEnd++;
      const i = live.indexOf(a);
      if (i >= 0) live.splice(i, 1);
      const rec: LeaveRecord = {
        id: a.id,
        teaching: a.teaching,
        atSec: runner.elapsedSec,
        ageSec: a.ageSec,
        counteredSec: a.counteredSec,
        gapSec: null,
      };
      leaves.push(rec);
      pendingGap.push(rec);
    },
    onCaught(a) {
      if (ended) eventsAfterEnd++;
      ended = true;
      caughtFired++;
      caught = { id: a.id, teaching: a.teaching, atSec: runner.elapsedSec, ageSec: a.ageSec, meter: a.meter };
      live.length = 0;
    },
    onSurvived() {
      if (ended) eventsAfterEnd++;
      ended = true;
      survivedFired++;
      live.length = 0;
    },
  });

  const initialDue = {} as Record<ThreatId, number | null>;
  for (const id of Object.keys(CONFIG.threats) as ThreatId[]) initialDue[id] = runner.nextAttackInSec(id);

  const peakMeter: NightLog['peakMeter'] = { value: 0, id: null, atSec: 0 };
  // Guard against a runner that never ends the night (the outcome then stays 'running').
  const maxFrames = 2_000_000;
  let frames = 0;
  while (runner.state === 'running' && frames < maxFrames && runner.elapsedSec <= tuning.lengthSec + 10) {
    const countering = opts.player.plan(runner);
    runner.update(dt, countering);
    frames++;
    if (runner.state === 'running') {
      for (const rec of pendingGap) {
        const next = runner.nextAttackInSec(rec.id);
        if (next !== null) rec.gapSec = runner.elapsedSec + next - rec.atSec;
      }
      for (const a of runner.activeAttacks()) {
        if (a.meter > peakMeter.value) {
          peakMeter.value = a.meter;
          peakMeter.id = a.id;
          peakMeter.atSec = runner.elapsedSec;
        }
      }
    }
    pendingGap.length = 0;
    opts.onFrame?.(runner, live);
  }
  const finalCaught = caught as CaughtRecord | null;
  if (finalCaught && finalCaught.meter > peakMeter.value) {
    peakMeter.value = finalCaught.meter;
    peakMeter.id = finalCaught.id;
    peakMeter.atSec = finalCaught.atSec;
  }

  // Probe: once the night is over, further updates must change nothing.
  ended = true;
  const activeAtEnd = runner.activeAttacks().length;
  const endState = runner.state;
  const endElapsed = runner.elapsedSec;
  for (let i = 0; i < 30; i++) runner.update(dt, () => false);

  return {
    night: opts.night,
    seed: opts.seed,
    tuning,
    outcome: endState,
    elapsedSec: endElapsed,
    frames,
    starts,
    leaves,
    caught: finalCaught,
    survivedFired,
    caughtFired,
    initialDue,
    maxConcurrentSeen,
    peakMeter,
    activeAtEnd,
    afterEnd: {
      events: eventsAfterEnd,
      elapsedDelta: runner.elapsedSec - endElapsed,
      stateChanged: runner.state !== endState,
    },
  };
}

/** caughtAfterSec / aggression: how long an uncountered attack takes to catch. */
export function effectiveCaughtAfterSec(id: ThreatId, aggression: number): number {
  return CONFIG.threats[id].caughtAfterSec / aggression;
}

/** The range [lo, hi] that sampleGap(id) can return on a night. */
export function gapRange(id: ThreatId, aggression: number): [number, number] {
  const base = CONFIG.threats[id].avgGapSec / aggression;
  return [base * CONFIG.scheduler.gapJitterMin, base * CONFIG.scheduler.gapJitterMax];
}

/** Compact one-line description of a night log for failure messages. */
export function describeLog(log: NightLog): string {
  const starts = log.starts
    .map((s) => `${s.atSec.toFixed(2)}s ${s.id}${s.teaching ? '(T)' : ''}`)
    .join(', ');
  const c = log.caught
    ? ` caught by ${log.caught.id} at ${log.caught.atSec.toFixed(2)}s (age ${log.caught.ageSec.toFixed(2)}s)`
    : '';
  return `night ${log.night} seed ${log.seed}: ${log.outcome}${c}; starts: [${starts}]`;
}
