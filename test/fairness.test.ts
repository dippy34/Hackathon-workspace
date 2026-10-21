/**
 * Fairness simulation: DESIGN.md promises "the game never starts an attack
 * that can't be survived". We run every night for 300 seeds with an "ideal
 * human" (two hands, 0.8 s reaction, 0.3 s hand moves; see test/sim/player.ts)
 * and check that it is never caught, and that every attack start obeys the
 * scheduler rules of the spec:
 *  - at most maxConcurrent attacks (3 on night 5, 2 otherwise);
 *  - the fairness rule for hands threats, generalised to several active hands
 *    attacks: caughtAfter / aggression > SUM(h.remainingLeaveSec + reactionSec),
 *    plus one more reactionSec while none of them is being countered yet, and
 *    never less than reactionSec - (time since a hands-attack last left);
 *  - teaching attacks (a threat's first attack on its introduction night)
 *    start within teachingStartWithinSec, first, and alone;
 *  - quiet opening / closing windows and the gap sampling ranges.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  CONFIG,
  THREAT_IDS,
  introducedOnNight,
  nightTuning,
  type NightTuning,
  type ThreatId,
} from '../src/config.js';
import type { AttackView, NightRunnerLike } from '../src/core/types.js';
import {
  EPS,
  IdealPlayer,
  SIM_DT,
  SequentialPlayer,
  alwaysCounters,
  describeLog,
  effectiveCaughtAfterSec,
  gapRange,
  runNight,
  type NightLog,
} from './sim/player.js';

const SEEDS = 300;
/** Seeds that also get the (slower) per-frame accessor checks. */
const DEEP_SEEDS = 25;
const NIGHTS = CONFIG.nights.map((n) => n.night);
const S = CONFIG.scheduler;
const usesHands = (id: ThreatId) => CONFIG.threats[id].usesHands;

/** Per-frame checks of the debug accessors and of events vs. activeAttacks(). */
function frameChecker(tuning: NightTuning, seed: number, out: string[]) {
  const night = tuning.night;
  const inNight = new Set<ThreatId>(tuning.threats);
  const lastDueAt = new Map<ThreatId, number>();
  const report = (runner: NightRunnerLike, msg: string) => {
    if (out.length < 40) out.push(`night ${night} seed ${seed} t=${runner.elapsedSec.toFixed(3)}: ${msg}`);
  };

  return (runner: NightRunnerLike, live: readonly AttackView[]) => {
    if (runner.state !== 'running') return;
    const active = runner.activeAttacks();

    if (active.length > tuning.maxConcurrent) report(runner, `${active.length} active > maxConcurrent`);
    for (const a of active) if (a.state !== 'active') report(runner, `activeAttacks() holds a '${a.state}' attack`);
    const sameSet = active.length === live.length && active.every((a) => live.includes(a));
    if (!sameSet) {
      report(
        runner,
        `activeAttacks() [${active.map((a) => a.id)}] != attacks started and not left [${live.map((a) => a.id)}]`,
      );
    }
    const expectRemaining = Math.max(0, tuning.lengthSec - runner.elapsedSec);
    if (Math.abs(runner.remainingSec - expectRemaining) > EPS) {
      report(runner, `remainingSec ${runner.remainingSec} != ${expectRemaining}`);
    }

    for (const id of THREAT_IDS) {
      const next = runner.nextAttackInSec(id);
      const reason = runner.blockedReason(id);
      if (!inNight.has(id)) {
        if (next !== null) report(runner, `nextAttackInSec(${id}) = ${next} for a threat not in the night`);
        if (reason !== null) report(runner, `blockedReason(${id}) = '${reason}' for a threat not in the night`);
        continue;
      }
      const isActive = active.some((a) => a.id === id);
      if (isActive) {
        if (next !== null) report(runner, `nextAttackInSec(${id}) = ${next} while it is active`);
        if (reason !== null) report(runner, `blockedReason(${id}) = '${reason}' while it is active`);
        lastDueAt.delete(id);
        continue;
      }
      if (next === null) {
        report(runner, `nextAttackInSec(${id}) is null for an idle threat`);
        continue;
      }
      // A due threat keeps its due time while it waits: it is never re-rolled.
      const dueAt = runner.elapsedSec + next;
      const prev = lastDueAt.get(id);
      if (prev !== undefined && Math.abs(prev - dueAt) > EPS) {
        report(runner, `${id} due time moved from ${prev.toFixed(4)} to ${dueAt.toFixed(4)} while idle`);
      }
      lastDueAt.set(id, dueAt);
      // After update() the starts are done, so an idle threat past its due time is being held back.
      if (next < -EPS && reason === null) report(runner, `${id} is ${(-next).toFixed(3)}s overdue but blockedReason is null`);
      if (next > EPS && reason !== null) report(runner, `${id} is not due yet but blockedReason = '${reason}'`);
    }
  };
}

/** Checks every recorded start of one night log against the scheduler rules. */
function checkStarts(log: NightLog, out: string[]): void {
  const { tuning } = log;
  const where = `night ${log.night} seed ${log.seed}`;
  const teachingIds = tuning.threats.filter((id) => introducedOnNight(id) === tuning.night);
  const seen = new Set<ThreatId>();

  for (const s of log.starts) {
    const at = `${where} start #${s.index} ${s.id} at ${s.atSec.toFixed(3)}s`;
    if (!(tuning.threats as readonly ThreatId[]).includes(s.id)) out.push(`${at}: threat is not in this night`);

    // A fresh danger meter.
    if (s.fresh.state !== 'active' || s.fresh.meter !== 0 || s.fresh.counteredSec !== 0 || s.fresh.ageSec !== 0) {
      out.push(`${at}: attack does not start fresh ${JSON.stringify(s.fresh)}`);
    }

    // maxConcurrent.
    if (s.others.length + 1 > tuning.maxConcurrent) {
      out.push(`${at}: ${s.others.length + 1} concurrent > maxConcurrent ${tuning.maxConcurrent}`);
    }

    // Fairness rule for hands threats: the generalised sum, one more reaction
    // while no active hands-attack is being countered, and the hand-off
    // budget right after a hands-attack left.
    if (usesHands(s.id)) {
      const H = s.others.filter((o) => usesHands(o.id));
      let need = H.reduce((sum, h) => sum + h.remainingLeaveSec + S.reactionSec, 0);
      if (H.length > 0 && !H.some((h) => h.countering)) need += S.reactionSec;
      need = Math.max(need, S.reactionSec - s.sinceHandsLeaveSec);
      const have = effectiveCaughtAfterSec(s.id, tuning.aggression);
      if (need > 0 && !(have - need > -1e-9)) {
        out.push(
          `${at}: unfair, caughtAfter/aggr ${have.toFixed(3)}s <= ${need.toFixed(3)}s ` +
            `(active hands: ${H.map((h) => `${h.id} rem ${h.remainingLeaveSec.toFixed(2)}${h.countering ? '' : ' uncountered'}`).join(', ') || 'none'}; ` +
            `last hands leave ${s.sinceHandsLeaveSec.toFixed(3)}s ago)`,
        );
      }
    }

    // Teaching flag: exactly the first attack of a threat on its introduction night.
    const shouldTeach = teachingIds.includes(s.id) && !seen.has(s.id);
    if (s.teaching !== shouldTeach) out.push(`${at}: teaching = ${s.teaching}, expected ${shouldTeach}`);
    seen.add(s.id);

    // Nothing may start while a teaching attack is active.
    if (s.others.some((o) => o.teaching)) out.push(`${at}: started while a teaching attack was active`);

    if (s.teaching) {
      // Teaching attacks attack alone, and nothing (except earlier teaching attacks) started before them.
      if (s.others.length > 0) out.push(`${at}: teaching attack started with [${s.others.map((o) => o.id)}] active`);
      const before = log.starts.slice(0, s.index).filter((x) => !x.teaching);
      if (before.length > 0) out.push(`${at}: ${before.length} non-teaching attack(s) started before the teaching attack`);
      if (s.id === teachingIds[0]) {
        // The (first) teaching attack is due in [earliest, within - 0.5] and starts right away.
        if (s.atSec < S.teachingStartEarliestSec - EPS || s.atSec > S.teachingStartWithinSec + EPS) {
          out.push(`${at}: teaching attack outside [${S.teachingStartEarliestSec}, ${S.teachingStartWithinSec}]s`);
        }
      }
    } else if (s.atSec < S.quietOpeningSec - EPS) {
      out.push(`${at}: non-teaching attack inside the quiet opening (${S.quietOpeningSec}s)`);
    }

    // Quiet closing.
    if (s.atSec > tuning.lengthSec - S.quietClosingSec + EPS) {
      out.push(`${at}: attack inside the quiet closing (after ${tuning.lengthSec - S.quietClosingSec}s)`);
    }
  }

  // Every threat introduced tonight gets its teaching attack (the ideal player survives long enough).
  for (const id of teachingIds) {
    if (!log.starts.some((s) => s.id === id && s.teaching)) out.push(`${where}: no teaching attack for ${id}`);
  }

  // Gaps after a leave: avgGap / aggression * lerp(gapJitterMin, gapJitterMax, rng()).
  for (const l of log.leaves) {
    if (l.gapSec === null) continue;
    const [lo, hi] = gapRange(l.id, tuning.aggression);
    if (l.gapSec < lo - EPS || l.gapSec > hi + EPS) {
      out.push(`${where}: ${l.id} left at ${l.atSec.toFixed(3)}s, next due after ${l.gapSec.toFixed(3)}s, outside [${lo}, ${hi}]`);
    }
  }

  // First due times, before the first update.
  for (const id of THREAT_IDS) {
    const next = log.initialDue[id];
    if (!(tuning.threats as readonly ThreatId[]).includes(id)) {
      if (next !== null) out.push(`${where}: initial nextAttackInSec(${id}) = ${next} for a threat not in the night`);
      continue;
    }
    if (next === null) {
      out.push(`${where}: initial nextAttackInSec(${id}) is null`);
      continue;
    }
    let lo: number;
    let hi: number;
    if (id === teachingIds[0]) {
      [lo, hi] = [S.teachingStartEarliestSec, S.teachingStartWithinSec - 0.5];
    } else if (teachingIds.includes(id)) {
      [lo, hi] = [S.teachingStartEarliestSec, Infinity]; // later teaching attacks queue behind the first
    } else {
      const [g0, g1] = gapRange(id, tuning.aggression);
      [lo, hi] = [Math.max(S.quietOpeningSec, g0), Math.max(S.quietOpeningSec, g1)];
    }
    if (next < lo - EPS || next > hi + EPS) out.push(`${where}: initial due of ${id} ${next.toFixed(3)}s outside [${lo}, ${hi}]`);
  }
}

describe.each(NIGHTS)('night %i: ideal player over 300 seeds', (night) => {
  const tuning = nightTuning(night);
  const logs: NightLog[] = [];
  const frameViolations: string[] = [];

  beforeAll(() => {
    for (let seed = 0; seed < SEEDS; seed++) {
      const onFrame = seed < DEEP_SEEDS ? frameChecker(tuning, seed, frameViolations) : undefined;
      logs.push(runNight({ night, seed, player: new IdealPlayer(), dt: SIM_DT, onFrame }));
    }
  }, 180_000);

  it('the ideal player is never caught and survives the full night', () => {
    const failures = logs.filter((l) => l.outcome !== 'survived').map(describeLog);
    expect(failures, failures.slice(0, 5).join('\n')).toEqual([]);
    for (const l of logs) {
      expect(l.elapsedSec).toBeGreaterThanOrEqual(tuning.lengthSec - EPS);
      expect(l.elapsedSec).toBeLessThanOrEqual(tuning.lengthSec + SIM_DT + EPS);
      expect(l.survivedFired).toBe(1);
      expect(l.caughtFired).toBe(0);
    }
  });

  it('surviving drops the remaining attacks, and a finished night ignores further updates', () => {
    for (const l of logs) {
      expect(l.activeAtEnd).toBe(0);
      expect(l.afterEnd).toEqual({ events: 0, elapsedDelta: 0, stateChanged: false });
    }
  });

  it('every attack start obeys maxConcurrent, fairness, teaching and quiet-window rules', () => {
    const violations: string[] = [];
    for (const l of logs) checkStarts(l, violations);
    expect(violations.slice(0, 20), `${violations.length} violation(s)`).toEqual([]);
  });

  it(`never more than ${tuning.maxConcurrent} attacks at once`, () => {
    for (const l of logs) expect(l.maxConcurrentSeen).toBeLessThanOrEqual(tuning.maxConcurrent);
  });

  it('debug accessors and events agree with activeAttacks() every frame', () => {
    expect(frameViolations).toEqual([]);
  });

  it('every threat of the night attacks across the seeds (nobody is starved)', () => {
    const counts = Object.fromEntries(THREAT_IDS.map((id) => [id, 0])) as Record<ThreatId, number>;
    for (const l of logs) for (const s of l.starts) counts[s.id]++;
    for (const id of THREAT_IDS) {
      if ((tuning.threats as readonly ThreatId[]).includes(id)) expect(counts[id], id).toBeGreaterThan(0);
      else expect(counts[id], id).toBe(0);
    }

    // Tuning notes (informational): attacks per night and the closest call.
    const perNight = THREAT_IDS.filter((id) => (tuning.threats as readonly ThreatId[]).includes(id))
      .map((id) => `${id} ${(counts[id] / logs.length).toFixed(1)}`)
      .join(', ');
    const closest = logs.reduce((m, l) => (l.peakMeter.value > m.peakMeter.value ? l : m), logs[0]);
    const maxSeen = Math.max(...logs.map((l) => l.maxConcurrentSeen));
    console.info(
      `[fairness] night ${night}: attacks/night ${perNight}; max concurrent ${maxSeen}; ` +
        `closest call meter ${closest.peakMeter.value.toFixed(3)} (${closest.peakMeter.id}, seed ${closest.seed}, ` +
        `t=${closest.peakMeter.atSec.toFixed(2)}s)`,
    );
  });

  if (tuning.maxConcurrent > 2) {
    it(`reaches ${tuning.maxConcurrent} concurrent attacks at least once (note only)`, () => {
      const hits = logs.filter((l) => l.maxConcurrentSeen >= tuning.maxConcurrent).length;
      if (hits === 0) {
        console.warn(
          `[fairness] NOTE: night ${night} never had ${tuning.maxConcurrent} concurrent attacks in ${SEEDS} seeds ` +
            `(the fairness rule may make the 3-attack allowance unreachable).`,
        );
      } else {
        console.info(`[fairness] night ${night}: ${tuning.maxConcurrent} concurrent attacks in ${hits}/${SEEDS} seeds`);
      }
      expect(true).toBe(true);
    });
  }
});

/**
 * Stress tunings (not the shipped table) that make rules bind which the
 * shipped numbers rarely or never exercise: a quiet opening longer than the
 * shortest gap, three threats queued behind a teaching attack, maxConcurrent 1,
 * and a short night where the quiet closing matters. The rules must hold for
 * any tuning, whoever is playing; survival is only promised for the shipped one.
 */
const STRESS: { name: string; tuning: NightTuning }[] = [
  {
    name: 'aggression 4, no teaching, 3 concurrent',
    tuning: { night: 5, threats: ['underDesk', 'peeker', 'listener', 'knocker'], aggression: 4, lengthSec: 120, maxConcurrent: 3 },
  },
  {
    name: 'night-1 teaching with every other threat queued',
    tuning: { night: 1, threats: ['underDesk', 'peeker', 'listener', 'knocker'], aggression: 2, lengthSec: 120, maxConcurrent: 3 },
  },
  {
    name: 'maxConcurrent 1',
    tuning: { night: 4, threats: ['underDesk', 'peeker', 'listener', 'knocker'], aggression: 1.3, lengthSec: 90, maxConcurrent: 1 },
  },
  {
    name: 'short night, closing window binds',
    tuning: { night: 3, threats: ['listener', 'peeker', 'knocker'], aggression: 2.5, lengthSec: 30, maxConcurrent: 2 },
  },
];

describe.each(STRESS)('stress tuning: $name', ({ tuning }) => {
  it.each([
    ['always-countering oracle', () => alwaysCounters],
    ['ideal player', () => new IdealPlayer()],
  ] as const)('every start obeys the scheduler rules (%s, 100 seeds)', (_name, makePlayer) => {
    const violations: string[] = [];
    const frameViolations: string[] = [];
    let starts = 0;
    for (let seed = 0; seed < 100; seed++) {
      const onFrame = seed < 10 ? frameChecker(tuning, seed, frameViolations) : undefined;
      const log = runNight({ night: tuning.night, tuning, seed, player: makePlayer(), onFrame });
      expect(log.outcome).not.toBe('running');
      checkStarts(log, violations);
      starts += log.starts.length;
      expect(log.afterEnd).toEqual({ events: 0, elapsedDelta: 0, stateChanged: false });
      if (log.outcome === 'survived') expect(log.activeAtEnd).toBe(0);
    }
    expect(starts).toBeGreaterThanOrEqual(100); // at least one attack per seed
    expect(violations.slice(0, 20), `${violations.length} violation(s)`).toEqual([]);
    expect(frameViolations).toEqual([]);
  }, 60_000);
});

/**
 * Regression: players whose hands are NOT already in place. The fairness rule
 * used to count an untouched hands-attack's full "leaves after" as if the
 * player were already countering it (night 2: a Peeker could join a fresh
 * Under the Desk, 8 s > 6 s + 1.5 s, leaving 2 s for two reactions), and it
 * vanished in the substep a hands-attack left (Under the Desk, whose caught
 * after is under 1.5 s on nights 3-5, started while a hand was still on its
 * way back from the window). Both players below react within DESIGN.md's
 * budgets, so the scheduler must never catch them.
 */
describe('fairness with hands that are not already in place', () => {
  const SLOW_SEEDS = 150;
  describe.each([
    [1.0, 1.4],
    [1.2, 0.9],
    [0.5, 1.45],
    [1.4, 1.45],
  ])('one-at-a-time player, reaction %s s, switch %s s', (reactionSec, switchSec) => {
    it.each(NIGHTS)('night %i: never caught', (night) => {
      const failures: string[] = [];
      for (let seed = 0; seed < SLOW_SEEDS; seed++) {
        const log = runNight({ night, seed, player: new SequentialPlayer({ reactionSec, switchSec }) });
        if (log.outcome !== 'survived') failures.push(describeLog(log));
      }
      expect(failures.slice(0, 3), `${failures.length}/${SLOW_SEEDS} caught`).toEqual([]);
    });
  });

  it.each([1.0, 1.2, 1.4])('two-hand ideal player with %s s hand moves is never caught on any night', (moveSec) => {
    const failures: string[] = [];
    for (const night of NIGHTS) {
      for (let seed = 0; seed < SLOW_SEEDS; seed++) {
        const log = runNight({ night, seed, player: new IdealPlayer({ moveSec }) });
        if (log.outcome !== 'survived') failures.push(describeLog(log));
      }
    }
    expect(failures.slice(0, 3), `${failures.length} caught`).toEqual([]);
  });
});

describe('ideal player model sanity', () => {
  it('is caught when it reacts too slowly for Under the Desk (the harness can fail)', () => {
    // 1.6 s reaction > 1.5 s caughtAfter: night 1's teaching attack must catch it.
    const log = runNight({ night: 1, seed: 1, player: new IdealPlayer({ reactionSec: 1.6 }) });
    expect(log.outcome).toBe('caught');
    expect(log.caught?.id).toBe('underDesk');
  });

  it('the one-at-a-time player is caught when its switch is longer than the 1.5 s budget', () => {
    // 2.5 s to get from one hands-counter to the next breaks the promise somewhere on night 4.
    let caught = 0;
    for (let seed = 0; seed < 50; seed++) {
      const log = runNight({ night: 4, seed, player: new SequentialPlayer({ reactionSec: 0.5, switchSec: 2.5 }) });
      if (log.outcome === 'caught') caught++;
    }
    expect(caught).toBeGreaterThan(0);
  });
});
