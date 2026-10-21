import { CONFIG, NIGHT_COUNT, nightTuning, type NightTuning, type ThreatId } from '../config.js';
import { TIME_EPS } from './math.js';
import { NightRunner } from './night-runner.js';
import { mulberry32, randomSeed } from './rng.js';
import type { CounteringFn, FlowEvents, NightEvents, NightRunnerLike, Phase, Rng } from './types.js';

const NEVER_COUNTERING: CounteringFn = () => false;

/**
 * The whole run: title -> intro -> nights 1..NIGHT_COUNT -> ending
 * (DESIGN.md core rule 5, "The nights", "The ending").
 *
 *   title --begin()--> intro --completeIntro()--> nightIntro(1)
 *   nightIntro --nightIntroSec (restartIntroSec after a catch)--> night (fresh NightRunner)
 *   night --caught--> caught --pauseSec--> nightIntro(same night)   [restarts++]
 *   night --survived--> nightCleared --nightClearedSec--> nightIntro(night + 1)
 *   night --survived on the last night--> ending
 *
 * title, intro and ending have no timers. At most one transition happens per
 * update(); the rest of that frame's dt is not carried into the next phase.
 * NightRunner events are forwarded to `events`; onPhaseChange fires on every
 * transition (including a debug jump into the phase it is already in).
 *
 * Timing after a catch (DESIGN.md "Implementation notes", Caught): the caught
 * phase lasts `caught.pauseSec`, then the night restarts with the shorter
 * `flow.restartIntroSec` lead-in before its clock starts again.
 *
 * Disabled threats (DESIGN.md "Comfort and accessibility": no microphone means
 * no Listener): `setDisabledThreats` removes threats from the schedule of every
 * night built afterwards. A disabled threat never attacks, never counts toward
 * maxConcurrent and has no teaching attack (night 3 without the Listener runs
 * with just Under the Desk and the Peeker, and no teaching moment).
 *
 * A runner the flow abandons (debug jump, restart) is disposed at once, and
 * events from any runner but the current one are dropped, so an event handler
 * that moves the flow can't leak the old night's events into the new one.
 */
export class GameFlow {
  private readonly events: FlowEvents;
  private readonly rng: Rng;
  private disabled: readonly ThreatId[] = [];
  private _phase: Phase = 'title';
  private _night = 0;
  private _phaseTime = 0;
  private _runner: NightRunner | null = null;
  private _lastCaughtBy: ThreatId | null = null;
  private _restarts = 0;
  private introSec: number = CONFIG.flow.nightIntroSec;

  constructor(events: FlowEvents = {}, rng: Rng = mulberry32(randomSeed())) {
    this.events = events;
    this.rng = rng;
  }

  get phase(): Phase {
    return this._phase;
  }
  /** Current night (1..NIGHT_COUNT); 0 during title and intro. */
  get night(): number {
    return this._night;
  }
  /** Seconds spent in the current phase. */
  get phaseTimeSec(): number {
    return this._phaseTime;
  }
  /** Tonight's runner: null during nightIntro (and before night 1); kept through caught / nightCleared / ending. */
  get runner(): NightRunnerLike | null {
    return this._runner;
  }
  /** Threat that caught the player most recently on the current night (kept across its restarts). */
  get lastCaughtBy(): ThreatId | null {
    return this._lastCaughtBy;
  }
  /** Times the current night has been restarted after a catch. */
  get restarts(): number {
    return this._restarts;
  }
  /** Threats removed from the schedule (see setDisabledThreats). */
  get disabledThreats(): readonly ThreatId[] {
    return this.disabled;
  }

  /**
   * Removes threats from the schedule, e.g. the Listener when the microphone
   * is denied (DESIGN.md "Comfort and accessibility"). Takes effect for the
   * next night (or restart) whose clock starts, not for a night already
   * running. The list is copied; pass [] to enable everything again.
   */
  setDisabledThreats(ids: readonly ThreatId[]): void {
    this.disabled = [...ids];
  }

  begin(): void {
    if (this._phase === 'title') this.setPhase('intro');
  }

  completeIntro(): void {
    if (this._phase === 'intro') this.enterNightIntro(1, false);
  }

  /** Debug: jump from any phase to the start of night `n` (1..NIGHT_COUNT), as a fresh night. */
  debugJumpToNight(n: number): void {
    if (!Number.isInteger(n) || n < 1 || n > NIGHT_COUNT) {
      throw new RangeError(`No night ${n} (expected 1..${NIGHT_COUNT})`);
    }
    this.enterNightIntro(n, false);
  }

  update(dtSec: number, countering: CounteringFn = NEVER_COUNTERING): void {
    if (!(dtSec > 0) || !Number.isFinite(dtSec)) return;
    this._phaseTime += dtSec;
    switch (this._phase) {
      case 'nightIntro':
        if (this._phaseTime >= this.introSec - TIME_EPS) {
          this._runner = this.createRunner();
          this.setPhase('night');
        }
        return;
      case 'night': {
        const runner = this._runner!;
        runner.update(dtSec, countering);
        // An event handler may have moved the flow (e.g. a debug jump); don't override it.
        if (this._phase !== 'night' || this._runner !== runner) return;
        if (runner.state === 'caught') this.setPhase('caught');
        else if (runner.state === 'survived') this.setPhase(this._night >= NIGHT_COUNT ? 'ending' : 'nightCleared');
        return;
      }
      case 'caught':
        if (this._phaseTime >= CONFIG.caught.pauseSec - TIME_EPS) this.enterNightIntro(this._night, true);
        return;
      case 'nightCleared':
        if (this._phaseTime >= CONFIG.flow.nightClearedSec - TIME_EPS) this.enterNightIntro(this._night + 1, false);
        return;
      default:
        return; // title, intro, ending: no timers
    }
  }

  private enterNightIntro(night: number, restart: boolean): void {
    if (restart) {
      this._restarts++;
    } else {
      this._restarts = 0;
      this._lastCaughtBy = null;
    }
    this._night = night;
    this._runner?.dispose();
    this._runner = null;
    this.introSec = restart ? CONFIG.flow.restartIntroSec : CONFIG.flow.nightIntroSec;
    this.setPhase('nightIntro');
  }

  /** Tonight's runner, minus disabled threats, with events forwarded only while it is current. */
  private createRunner(): NightRunner {
    const base = nightTuning(this._night);
    const disabled = this.disabled;
    const tuning: NightTuning =
      disabled.length === 0 ? base : { ...base, threats: base.threats.filter((id) => !disabled.includes(id)) };
    const events = this.events;
    const isCurrent = () => this._runner === runner;
    const forward: NightEvents = {
      onAttackStart: (a) => {
        if (isCurrent()) events.onAttackStart?.(a);
      },
      onAttackLeave: (a) => {
        if (isCurrent()) events.onAttackLeave?.(a);
      },
      onCaught: (a) => {
        if (!isCurrent()) return;
        this._lastCaughtBy = a.id;
        events.onCaught?.(a);
      },
      onSurvived: () => {
        if (isCurrent()) events.onSurvived?.();
      },
    };
    const runner: NightRunner = new NightRunner(tuning, this.rng, forward);
    return runner;
  }

  private setPhase(next: Phase): void {
    const prev = this._phase;
    this._phase = next;
    this._phaseTime = 0;
    this.events.onPhaseChange?.(next, this._night, prev);
  }
}
