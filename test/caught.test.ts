/**
 * Getting caught: a player who never counters is caught on every night, the
 * teaching attack is the first catch on its introduction night (it attacks
 * alone), and ignoring exactly one threat gets you caught by that threat.
 * Also: big frame times are substepped, and a finished night stays finished.
 */

import { describe, expect, it } from 'vitest';
import { CONFIG, introducedOnNight, nightTuning, type ThreatId } from '../src/config.js';
import { NightRunner } from '../src/core/night-runner.js';
import { mulberry32 } from '../src/core/rng.js';
import {
  EPS,
  SIM_DT,
  alwaysCounters,
  countersAllExcept,
  describeLog,
  effectiveCaughtAfterSec,
  neverCounters,
  runNight,
} from './sim/player.js';

const NIGHTS = CONFIG.nights.map((n) => n.night);
const S = CONFIG.scheduler;
/** NightRunner substeps a frame in chunks of at most this many seconds. */
const MAX_SUBSTEP = 1 / 30;

/** [night, threat introduced that night] for every night that introduces one. */
const INTRODUCTIONS: [number, ThreatId][] = NIGHTS.flatMap((night) =>
  nightTuning(night)
    .threats.filter((id) => introducedOnNight(id) === night)
    .map((id) => [night, id] as [number, ThreatId]),
);

/** [threat, night] for every night that contains the threat. */
const THREAT_NIGHTS: [ThreatId, number][] = NIGHTS.flatMap((night) =>
  nightTuning(night).threats.map((id) => [id, night] as [ThreatId, number]),
);

describe('a player who never counters', () => {
  it.each(NIGHTS)('is caught on night %i, on every seed', (night) => {
    for (let seed = 0; seed < 50; seed++) {
      const log = runNight({ night, seed, player: neverCounters });
      expect(log.outcome, describeLog(log)).toBe('caught');
      expect(log.caughtFired).toBe(1);
      expect(log.survivedFired).toBe(0);
      expect(log.caught).not.toBeNull();
      // Uncountered, the meter fills in exactly caughtAfter / aggression (to within one frame).
      const eff = effectiveCaughtAfterSec(log.caught!.id, log.tuning.aggression);
      expect(log.caught!.ageSec).toBeGreaterThanOrEqual(eff - EPS);
      expect(log.caught!.ageSec).toBeLessThanOrEqual(eff + SIM_DT + EPS);
      expect(log.caught!.meter).toBe(1);
      // A finished night ignores further updates.
      expect(log.afterEnd).toEqual({ events: 0, elapsedDelta: 0, stateChanged: false });
    }
  });

  it('the shipped table introduces one threat on each of nights 1-4', () => {
    expect(INTRODUCTIONS).toEqual([
      [1, 'underDesk'],
      [2, 'peeker'],
      [3, 'listener'],
      [4, 'knocker'],
    ]);
  });

  it.each(INTRODUCTIONS)(
    'on night %i the first catch is by %s, its teaching attack, which attacked alone',
    (night, id) => {
      const eff = effectiveCaughtAfterSec(id, nightTuning(night).aggression);
      for (let seed = 0; seed < 50; seed++) {
        const log = runNight({ night, seed, player: neverCounters });
        const where = describeLog(log);
        expect(log.caught?.id, where).toBe(id);
        expect(log.caught?.teaching, where).toBe(true);
        // The teaching attack is the only attack of the night: it starts first and nothing joins it.
        expect(log.starts.map((s) => s.id), where).toEqual([id]);
        expect(log.starts[0].teaching).toBe(true);
        expect(log.starts[0].others).toEqual([]);
        // It starts within teachingStartWithinSec, so the catch comes at most eff later.
        expect(log.starts[0].atSec).toBeGreaterThanOrEqual(S.teachingStartEarliestSec - EPS);
        expect(log.starts[0].atSec).toBeLessThanOrEqual(S.teachingStartWithinSec + EPS);
        expect(log.caught!.atSec).toBeLessThanOrEqual(S.teachingStartWithinSec + eff + SIM_DT + EPS);
      }
    },
  );
});

describe('a player who counters everything except one threat', () => {
  it.each(THREAT_NIGHTS)('ignoring %s on night %i gets you caught by it', (x, night) => {
    const eff = effectiveCaughtAfterSec(x, nightTuning(night).aggression);
    for (let seed = 0; seed < 20; seed++) {
      const log = runNight({ night, seed, player: countersAllExcept(x) });
      const where = describeLog(log);
      expect(log.outcome, where).toBe('caught');
      expect(log.caught?.id, where).toBe(x);
      expect(log.caught!.ageSec).toBeGreaterThanOrEqual(eff - EPS);
      expect(log.caught!.ageSec).toBeLessThanOrEqual(eff + SIM_DT + EPS);
      // On its introduction night the catch is by its teaching attack.
      expect(log.caught!.teaching, where).toBe(introducedOnNight(x) === night);
      // Every other attack that ended did so by leaving, after exactly leavesAfterSec of countering.
      for (const l of log.leaves) {
        expect(l.id).not.toBe(x);
        expect(l.counteredSec).toBeGreaterThanOrEqual(CONFIG.threats[l.id].leavesAfterSec - EPS);
        expect(l.counteredSec).toBeLessThanOrEqual(CONFIG.threats[l.id].leavesAfterSec + SIM_DT + EPS);
      }
    }
  });
});

describe('a player who counters everything from the first frame', () => {
  it.each(NIGHTS)('survives night %i, and every attack leaves after leavesAfterSec', (night) => {
    for (let seed = 0; seed < 30; seed++) {
      const log = runNight({ night, seed, player: alwaysCounters });
      expect(log.outcome, describeLog(log)).toBe('survived');
      expect(log.survivedFired).toBe(1);
      expect(log.caughtFired).toBe(0);
      expect(log.peakMeter.value).toBe(0);
      for (const l of log.leaves) {
        const leaves = CONFIG.threats[l.id].leavesAfterSec;
        expect(l.ageSec).toBeGreaterThanOrEqual(leaves - EPS);
        expect(l.ageSec).toBeLessThanOrEqual(leaves + SIM_DT + EPS);
        expect(l.counteredSec).toBeCloseTo(l.ageSec, 9);
      }
      expect(log.afterEnd).toEqual({ events: 0, elapsedDelta: 0, stateChanged: false });
    }
  });
});

describe('frame time handling', () => {
  it('a night stepped at the caller clamp (0.1 s frames) lasts lengthSec', () => {
    const tuning = nightTuning(5);
    const runner = new NightRunner(tuning, mulberry32(99));
    let frames = 0;
    while (runner.state === 'running' && frames < 5000) {
      runner.update(0.1, () => true);
      frames++;
      if (runner.state === 'running') expect(runner.elapsedSec).toBeCloseTo(frames * 0.1, 6);
    }
    expect(runner.state).toBe('survived');
    expect(frames * 0.1).toBeGreaterThanOrEqual(tuning.lengthSec - EPS);
    expect(frames * 0.1).toBeLessThanOrEqual(tuning.lengthSec + 0.1 + EPS);
    expect(runner.activeAttacks()).toEqual([]);
  });

  it.each([0.1, 0.25, 1.0])(
    'with %s s frames a catch still lands within one 1/30 s substep of caughtAfter / aggression',
    (dt) => {
      for (const night of NIGHTS) {
        for (let seed = 0; seed < 10; seed++) {
          const log = runNight({ night, seed, player: neverCounters, dt });
          expect(log.outcome, describeLog(log)).toBe('caught');
          const eff = effectiveCaughtAfterSec(log.caught!.id, log.tuning.aggression);
          expect(log.caught!.ageSec).toBeGreaterThanOrEqual(eff - EPS);
          expect(log.caught!.ageSec).toBeLessThanOrEqual(eff + MAX_SUBSTEP + EPS);
        }
      }
    },
  );

  it.each([
    [1, 'underDesk'],
    [2, 'peeker'],
  ] as [number, ThreatId][])(
    'night %i: a 1 s hitch right after the %s teaching attack starts does not instantly catch',
    (night, id) => {
      let started = false;
      const runner = new NightRunner(nightTuning(night), mulberry32(5), { onAttackStart: () => (started = true) });
      while (!started) runner.update(SIM_DT, () => false);
      const a = runner.activeAttacks()[0];
      expect(a.id).toBe(id);
      runner.update(1.0, () => false);
      // 1 s < caughtAfter on these nights, so the player is still alive, and the
      // meter is exactly what the attack's own (substepped) time says it is.
      expect(runner.state).toBe('running');
      expect(a.state).toBe('active');
      expect(a.ageSec).toBeGreaterThan(0);
      expect(a.ageSec).toBeLessThanOrEqual(1.0 + EPS);
      expect(a.meter).toBeCloseTo((a.ageSec * nightTuning(night).aggression) / CONFIG.threats[id].caughtAfterSec, 9);
    },
  );
});
