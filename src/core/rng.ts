import type { Rng } from './types.js';

/**
 * mulberry32: a tiny, fast 32-bit PRNG. The same seed always yields the same
 * sequence of values in [0, 1), so a seeded night replays identically (tests,
 * bug repro).
 */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A fresh 32-bit seed for normal (non-reproducible) play. */
export function randomSeed(): number {
  return (Math.random() * 4294967296) >>> 0;
}
