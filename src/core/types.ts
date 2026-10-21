/**
 * Pure game-logic contracts. Nothing under src/core may import three,
 * @iwsdk/core, the DOM or Web Audio, so the whole rules engine runs (and is
 * tested) in plain Node.
 */

import type { NightTuning, ThreatId } from '../config.js';

export type { ThreatId };

/** Deterministic random source in [0, 1). */
export type Rng = () => number;

export type AttackState = 'active' | 'caught' | 'left';

/** Read-only view of one attack's danger meter. */
export interface AttackView {
  readonly id: ThreatId;
  /** 0 = safe, 1 = caught. */
  readonly meter: number;
  /** Seconds of countering accumulated during this attack. */
  readonly counteredSec: number;
  /** leavesAfterSec - counteredSec (never negative). */
  readonly remainingLeaveSec: number;
  /** Seconds since the attack started. */
  readonly ageSec: number;
  readonly state: AttackState;
  /** True for the threat's first attack on the night it is introduced. */
  readonly teaching: boolean;
  /** Was the player countering on the last update? */
  readonly countering: boolean;
}

/** Answers "is the player countering this threat right now?" */
export type CounteringFn = (id: ThreatId) => boolean;

export interface NightEvents {
  onAttackStart?(attack: AttackView): void;
  /** The threat was countered long enough and retreats. */
  onAttackLeave?(attack: AttackView): void;
  /** The meter filled. The night is over (caught). */
  onCaught?(attack: AttackView): void;
  /** The night clock ran out with the player alive. */
  onSurvived?(): void;
}

export type NightState = 'running' | 'caught' | 'survived';

export interface NightRunnerLike {
  readonly tuning: NightTuning;
  readonly state: NightState;
  /** Seconds since the night clock started. */
  readonly elapsedSec: number;
  readonly remainingSec: number;
  /** Attacks currently in progress (state === 'active'). */
  activeAttacks(): readonly AttackView[];
  /** Seconds until each idle threat's next attack is due (debug). Negative = due but waiting on fairness. */
  nextAttackInSec(id: ThreatId): number | null;
  /** Why the scheduler is holding back a due attack, if it is (debug). */
  blockedReason(id: ThreatId): string | null;
  update(dtSec: number, countering: CounteringFn): void;
}

export type Phase =
  /** 2D page / waiting to enter XR. */
  | 'title'
  /** Calibration + tutorial + (fallback) window/door placement. */
  | 'intro'
  /** "Night N" card while the room goes dark. Clock not running yet. */
  | 'nightIntro'
  /** The night clock is running and threats attack. */
  | 'night'
  /** Caught moment + pause; then restarts the same night (back to nightIntro). */
  | 'caught'
  /** Survived; brief breath before the next night. */
  | 'nightCleared'
  /** After night 5: "You held still." */
  | 'ending';

export interface FlowEvents extends NightEvents {
  onPhaseChange?(phase: Phase, night: number, prev: Phase): void;
}
