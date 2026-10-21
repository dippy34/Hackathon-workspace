/** Tiny numeric helpers shared by the rules engine (pure, no deps). */

/**
 * Tolerance for comparing accumulated clocks against thresholds. A night is
 * thousands of small dt additions, so `sum === 120` may land at 119.9999999;
 * a microsecond of slack keeps "after N seconds" exact without changing play.
 */
export const TIME_EPS = 1e-6;

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
