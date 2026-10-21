/** mulberry32: the seeded RNG every test (and the game) relies on for determinism. */

import { describe, expect, it } from 'vitest';
import { mulberry32 } from '../src/core/rng.js';

describe('mulberry32', () => {
  it('is deterministic per seed', () => {
    const a = mulberry32(1234);
    const b = mulberry32(1234);
    for (let i = 0; i < 1000; i++) expect(a()).toBe(b());
  });

  it('different seeds give different streams', () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    const same = Array.from({ length: 20 }, () => a() === b()).filter(Boolean).length;
    expect(same).toBeLessThan(20);
  });

  it('returns values in [0, 1) spread over the range', () => {
    const r = mulberry32(42);
    let min = 1;
    let max = 0;
    let sum = 0;
    const n = 20_000;
    for (let i = 0; i < n; i++) {
      const x = r();
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThan(1);
      min = Math.min(min, x);
      max = Math.max(max, x);
      sum += x;
    }
    expect(min).toBeLessThan(0.01);
    expect(max).toBeGreaterThan(0.99);
    expect(sum / n).toBeGreaterThan(0.48);
    expect(sum / n).toBeLessThan(0.52);
  });

  it('accepts seed 0', () => {
    const r = mulberry32(0);
    const xs = Array.from({ length: 5 }, () => r());
    expect(new Set(xs).size).toBe(5);
  });
});
