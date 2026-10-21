import { CONFIG, type ThreatId, type ThreatTuning } from '../config.js';
import { TIME_EPS } from './math.js';
import type { AttackState, AttackView } from './types.js';

/**
 * One attack's danger meter (DESIGN.md "The threats": the shared meter).
 *
 * - Not countering: the meter fills at `aggression / caughtAfterSec` per
 *   second, so continuous neglect is caught after `caughtAfterSec / aggression`
 *   seconds (see `effectiveCaughtAfterSec`).
 * - Countering: the meter drains at `CONFIG.meterDrainMultiplier /
 *   caughtAfterSec` per second (a multiple of the 1.0x fill speed; aggression
 *   does not speed up draining) and countered time accumulates. Once the
 *   cumulative (not necessarily consecutive) countered time reaches
 *   `leavesAfterSec` the threat leaves. Aggression never changes leavesAfterSec.
 *
 * 'caught' and 'left' are terminal: later updates are ignored.
 */
export class Attack implements AttackView {
  readonly id: ThreatId;
  readonly tuning: ThreatTuning;
  readonly aggression: number;
  readonly teaching: boolean;

  private _meter = 0;
  private _counteredSec = 0;
  private _ageSec = 0;
  private _state: AttackState = 'active';
  private _countering = false;

  constructor(id: ThreatId, tuning: ThreatTuning, aggression: number, teaching = false) {
    this.id = id;
    this.tuning = tuning;
    this.aggression = aggression;
    this.teaching = teaching;
  }

  get meter(): number {
    return this._meter;
  }
  get counteredSec(): number {
    return this._counteredSec;
  }
  get ageSec(): number {
    return this._ageSec;
  }
  get state(): AttackState {
    return this._state;
  }
  get countering(): boolean {
    return this._countering;
  }
  /** Countered seconds still needed before the threat leaves (0 once it has left). */
  get remainingLeaveSec(): number {
    return this._state === 'left' ? 0 : Math.max(0, this.tuning.leavesAfterSec - this._counteredSec);
  }
  /** Seconds of continuous neglect, from an empty meter, until caught. */
  get effectiveCaughtAfterSec(): number {
    return this.tuning.caughtAfterSec / this.aggression;
  }

  update(dtSec: number, countering: boolean): void {
    if (this._state !== 'active') return;
    this._countering = countering;
    if (!(dtSec > 0)) return;
    this._ageSec += dtSec;
    const { caughtAfterSec, leavesAfterSec } = this.tuning;
    if (countering) {
      this._counteredSec += dtSec;
      this._meter = Math.max(0, this._meter - (dtSec * CONFIG.meterDrainMultiplier) / caughtAfterSec);
      if (this._counteredSec >= leavesAfterSec - TIME_EPS) this._state = 'left';
    } else {
      this._meter += (dtSec * this.aggression) / caughtAfterSec;
      if (this._meter >= 1 - TIME_EPS) {
        this._meter = 1;
        this._state = 'caught';
      }
    }
  }
}
