/**
 * Scheduling rules as pure functions (DESIGN.md "Fairness rules" and "The
 * nights"). NightRunner (night-runner.ts) owns the clock and state and calls
 * these to decide when each threat is due and whether it may start.
 */

import { CONFIG, introducedOnNight, type ThreatId } from '../config.js';
import { lerp } from './math.js';
import type { AttackView, Rng } from './types.js';

/**
 * A teaching attack is due no later than `teachingStartWithinSec` minus this
 * margin, so frame/substep granularity can never push its start past the
 * DESIGN.md "starts within 10 s" promise.
 */
export const TEACHING_START_MARGIN_SEC = 0.5;

/**
 * Interpretation of DESIGN.md "A threat's first appearance in a night is a
 * teaching moment": a threat teaches only on the night it is introduced
 * (`introducedOnNight(id) === night`), and only its FIRST attack that night is
 * the teaching attack. On later nights it is already known and attacks normally.
 */
export function isTeachingThreat(id: ThreatId, night: number): boolean {
  return introducedOnNight(id) === night;
}

/** Gap before a threat's next attack: (avgGapSec / aggression) x U[gapJitterMin, gapJitterMax]. */
export function sampleGapSec(id: ThreatId, aggression: number, rng: Rng): number {
  const s = CONFIG.scheduler;
  return (CONFIG.threats[id].avgGapSec / aggression) * lerp(s.gapJitterMin, s.gapJitterMax, rng());
}

/** Night-clock offset of a teaching attack: U[teachingStartEarliestSec, teachingStartWithinSec - margin]. */
export function sampleTeachingStartSec(rng: Rng): number {
  const s = CONFIG.scheduler;
  return lerp(s.teachingStartEarliestSec, s.teachingStartWithinSec - TEACHING_START_MARGIN_SEC, rng());
}

/** First due time of a non-teaching threat: one gap in, but never inside the quiet opening. */
export function sampleFirstDueSec(id: ThreatId, aggression: number, rng: Rng): number {
  return Math.max(CONFIG.scheduler.quietOpeningSec, sampleGapSec(id, aggression, rng));
}

/** Seconds of continuous neglect, from an empty meter, until `id` catches at this aggression. */
export function effectiveCaughtAfterSec(id: ThreatId, aggression: number): number {
  return CONFIG.threats[id].caughtAfterSec / aggression;
}

/**
 * How long the player's hands stay busy with what is already attacking:
 * the sum over active hands-attacks of (remainingLeaveSec + reactionSec).
 * 0 when no hands-attack is active. The Listener (usesHands false) never counts.
 */
export function handsBusySec(active: readonly AttackView[]): number {
  let sum = 0;
  for (let i = 0; i < active.length; i++) {
    const a = active[i];
    if (a.state === 'active' && CONFIG.threats[a.id].usesHands) {
      sum += a.remainingLeaveSec + CONFIG.scheduler.reactionSec;
    }
  }
  return sum;
}

/**
 * DESIGN.md "The rule": never start an attack that can't be survived. A
 * hands-threat may start while other hands-threats attack only if its
 * effective "caught after" is longer than `handsBusySec(active)`.
 *
 * With one active hands-attack this is exactly DESIGN.md's wording ("caught
 * after" > what's left of the first one's "leaves after" + 1.5 s). For 2+
 * active hands-attacks (night 5) it is generalised conservatively by summing:
 * the player may have to finish each one in turn before their hand is free.
 * Threats that don't use hands (the Listener) always pass.
 */
export function passesFairness(id: ThreatId, aggression: number, active: readonly AttackView[]): boolean {
  if (!CONFIG.threats[id].usesHands) return true;
  return effectiveCaughtAfterSec(id, aggression) > handsBusySec(active);
}
