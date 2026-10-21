/**
 * Scheduling rules as pure functions (DESIGN.md "Fairness rules" and "The
 * nights"). NightRunner (night-runner.ts) owns the clock and state and calls
 * these to decide when each threat is due and whether it may start.
 */

import { CONFIG, introducedOnNight, type ThreatId } from '../config.js';
import { lerp } from './math.js';
import type { AttackView, Rng } from './types.js';

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
  return lerp(s.teachingStartEarliestSec, s.teachingStartWithinSec - s.teachingStartMarginSec, rng());
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
 * How long the player's hands stay busy with what is already happening, in
 * seconds: the budget a new hands-threat's effective "caught after" must beat
 * (DESIGN.md "Fairness rules"). Worst case, the player works through the
 * hands-attacks one at a time and then has to get to the new one.
 *
 * - Each active hands-attack h adds `h.remainingLeaveSec + reactionSec`
 *   (finish it, then react / move a hand to the next one). With one active
 *   hands-attack that is exactly DESIGN.md's "what's left of the first one's
 *   'leaves after' time, plus 1.5 s to react"; for 2+ (night 5) the sum is the
 *   conservative generalisation.
 * - Engage: if hands-attacks are active but NONE of them is being countered
 *   right now (`countering` false: it just started, possibly earlier in this
 *   same substep, or the player is still getting a hand to it), one more
 *   `reactionSec` is added. "Leaves after" only counts down once the player is
 *   actually countering, and getting there is a reaction DESIGN.md budgets
 *   1.5 s for, so without this a fresh, untouched Under the Desk would let an
 *   8 s Peeker start that a within-budget player can't reach in time.
 * - Hand-off: with no hands-attack active, a hands-attack that left
 *   `sinceHandsLeaveSec` ago may still have a hand on its way back, so the
 *   budget is `max(0, reactionSec - sinceHandsLeaveSec)`. This keeps the rule
 *   continuous across a leave: one substep before it, the leaving attack
 *   counted 0 + reactionSec. (While any hands-attack is active its own term is
 *   at least reactionSec, which already covers the returning hand.)
 *
 * The Listener (usesHands false) never counts. Both extra terms only make the
 * rule stricter than DESIGN.md's wording, never looser.
 *
 * @param sinceHandsLeaveSec seconds since the most recent hands-attack left
 *   tonight (Infinity if none has).
 */
export function handsBusySec(active: readonly AttackView[], sinceHandsLeaveSec = Infinity): number {
  const reaction = CONFIG.scheduler.reactionSec;
  let sum = 0;
  let hands = 0;
  let engaged = false;
  for (let i = 0; i < active.length; i++) {
    const a = active[i];
    if (a.state === 'active' && CONFIG.threats[a.id].usesHands) {
      hands++;
      if (a.countering) engaged = true;
      sum += a.remainingLeaveSec + reaction;
    }
  }
  if (hands > 0 && !engaged) sum += reaction;
  return Math.max(sum, reaction - sinceHandsLeaveSec);
}

/**
 * DESIGN.md "The rule": never start an attack that can't be survived given
 * what's already happening. A hands-threat may start only if its effective
 * "caught after" (caughtAfterSec / aggression, since aggression makes the meter
 * fill faster) is longer than `handsBusySec(active, sinceHandsLeaveSec)`.
 *
 * With one active, countered hands-attack this is exactly DESIGN.md's wording
 * ("caught after" > what's left of the first one's "leaves after" + 1.5 s).
 * It is generalised (see handsBusySec) by summing over 2+ active hands-attacks
 * (night 5), by budgeting one more reaction while none of them is being
 * countered yet, and by a short hand-off budget right after one leaves.
 * Threats that don't use hands (the Listener) always pass.
 */
export function passesFairness(
  id: ThreatId,
  aggression: number,
  active: readonly AttackView[],
  sinceHandsLeaveSec = Infinity,
): boolean {
  if (!CONFIG.threats[id].usesHands) return true;
  return effectiveCaughtAfterSec(id, aggression) > handsBusySec(active, sinceHandsLeaveSec);
}
