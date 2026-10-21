/**
 * GameFlow: title -> intro -> nightIntro -> night -> nightCleared -> ... ->
 * ending, the caught -> restart loop, debugJumpToNight, and onPhaseChange.
 */

import { describe, expect, it } from 'vitest';
import { CONFIG, NIGHT_COUNT, nightTuning, type ThreatId } from '../src/config.js';
import { GameFlow } from '../src/core/game-flow.js';
import { mulberry32 } from '../src/core/rng.js';
import type { CounteringFn, FlowEvents, NightRunnerLike, Phase } from '../src/core/types.js';

const DT = 1 / 72;
const TOL = DT + 1e-6;
const always: CounteringFn = () => true;
const never: CounteringFn = () => false;

interface Change {
  phase: Phase;
  night: number;
  prev: Phase;
}

const last = <T>(xs: readonly T[]): T | undefined => xs[xs.length - 1];

/** A GameFlow with every event recorded. */
function recordedFlow(seed = 7) {
  const changes: Change[] = [];
  const log: string[] = [];
  const counts = { start: 0, leave: 0, caught: 0, survived: 0 };
  const caughtIds: ThreatId[] = [];
  let flow!: GameFlow;
  const events: FlowEvents = {
    onPhaseChange: (phase, night, prev) => {
      changes.push({ phase, night, prev });
      log.push(`phase ${prev}->${phase} n${night}`);
    },
    onAttackStart: (a) => {
      counts.start++;
      log.push(`start ${a.id}${a.teaching ? ' T' : ''} n${flow.night}`);
      if (flow.phase !== 'night') log.push(`!! attack started outside the night phase (${flow.phase})`);
    },
    onAttackLeave: (a) => {
      counts.leave++;
      log.push(`leave ${a.id}`);
    },
    onCaught: (a) => {
      counts.caught++;
      caughtIds.push(a.id);
      log.push(`caught ${a.id}`);
    },
    onSurvived: () => {
      counts.survived++;
      log.push('survived');
    },
  };
  flow = new GameFlow(events, mulberry32(seed));
  return { flow, changes, log, counts, caughtIds };
}

/**
 * Updates until the phase changes (or limitSec passes). Returns the time spent
 * in the phase the flow was in when called, counted in whole frames.
 */
function runPhase(flow: GameFlow, countering: CounteringFn, limitSec = 400): number {
  const start = flow.phase;
  let t = 0;
  while (flow.phase === start && t < limitSec) {
    flow.update(DT, countering);
    t += DT;
  }
  return t;
}

describe('GameFlow: start', () => {
  it('starts on the title with no night', () => {
    const flow = new GameFlow();
    expect(flow.phase).toBe('title');
    expect(flow.night).toBe(0);
    expect(flow.runner).toBeNull();
    expect(flow.lastCaughtBy).toBeNull();
    expect(flow.restarts).toBe(0);
  });

  it('title and intro have no timers', () => {
    const { flow, changes } = recordedFlow();
    for (let i = 0; i < 72 * 60; i++) flow.update(DT, always);
    expect(flow.phase).toBe('title');
    flow.begin();
    expect(flow.phase).toBe('intro');
    expect(flow.night).toBe(0);
    for (let i = 0; i < 72 * 60; i++) flow.update(DT, always);
    expect(flow.phase).toBe('intro');
    expect(changes).toEqual([{ phase: 'intro', night: 0, prev: 'title' }]);
  });

  it('begin() only works from the title', () => {
    const { flow, changes } = recordedFlow();
    flow.begin();
    flow.begin();
    expect(flow.phase).toBe('intro');
    flow.completeIntro();
    flow.begin();
    expect(flow.phase).toBe('nightIntro');
    expect(changes.map((c) => c.phase)).toEqual(['intro', 'nightIntro']);
  });

  it('completeIntro() goes to the night 1 intro, which lasts nightIntroSec', () => {
    const { flow, changes } = recordedFlow();
    flow.begin();
    flow.completeIntro();
    expect(flow.phase).toBe('nightIntro');
    expect(flow.night).toBe(1);
    expect(last(changes)).toEqual({ phase: 'nightIntro', night: 1, prev: 'intro' });

    let t = 0;
    while (t < CONFIG.flow.nightIntroSec - 2 * DT) {
      flow.update(DT, always);
      t += DT;
      expect(flow.phase).toBe('nightIntro');
      expect(flow.phaseTimeSec).toBeCloseTo(t, 6);
    }
    const rest = runPhase(flow, always);
    expect(t + rest).toBeGreaterThanOrEqual(CONFIG.flow.nightIntroSec - TOL);
    expect(t + rest).toBeLessThanOrEqual(CONFIG.flow.nightIntroSec + TOL);
    expect(flow.phase).toBe('night');
    expect(flow.phaseTimeSec).toBeLessThan(DT + 1e-6);
    expect(last(changes)).toEqual({ phase: 'night', night: 1, prev: 'nightIntro' });
  });

  it('the night phase has a fresh runner for that night', () => {
    const { flow } = recordedFlow();
    flow.begin();
    flow.completeIntro();
    runPhase(flow, always);
    const r = flow.runner;
    expect(r).not.toBeNull();
    expect(r!.tuning.night).toBe(1);
    expect(r!.tuning).toEqual(nightTuning(1));
    expect(r!.state).toBe('running');
    expect(r!.elapsedSec).toBeLessThan(DT + 1e-6);
    flow.update(DT, always);
    expect(r!.elapsedSec).toBeGreaterThan(0);
  });
});

describe('GameFlow: a full run with an always-countering player', () => {
  it('goes title -> intro -> nights 1-5 -> ending with the right timings', () => {
    const { flow, changes, counts, log } = recordedFlow(11);
    flow.begin();
    flow.completeIntro();

    const durations: { phase: Phase; night: number; sec: number }[] = [];
    let guard = 0;
    while (flow.phase !== 'ending' && guard++ < 100) {
      const phase = flow.phase;
      const night = flow.night;
      durations.push({ phase, night, sec: runPhase(flow, always) });
    }
    expect(flow.phase).toBe('ending');
    expect(flow.night).toBe(NIGHT_COUNT);
    expect(flow.restarts).toBe(0);

    // onPhaseChange for every transition, in order.
    const expected: Change[] = [
      { phase: 'intro', night: 0, prev: 'title' },
      { phase: 'nightIntro', night: 1, prev: 'intro' },
    ];
    for (let n = 1; n <= NIGHT_COUNT; n++) {
      expected.push({ phase: 'night', night: n, prev: 'nightIntro' });
      if (n < NIGHT_COUNT) {
        expected.push({ phase: 'nightCleared', night: n, prev: 'night' });
        expected.push({ phase: 'nightIntro', night: n + 1, prev: 'nightCleared' });
      } else {
        expected.push({ phase: 'ending', night: n, prev: 'night' });
      }
    }
    expect(changes).toEqual(expected);

    // Phase lengths.
    for (const d of durations) {
      const want =
        d.phase === 'nightIntro'
          ? CONFIG.flow.nightIntroSec
          : d.phase === 'night'
            ? nightTuning(d.night).lengthSec
            : d.phase === 'nightCleared'
              ? CONFIG.flow.nightClearedSec
              : NaN;
      expect(d.sec, `${d.phase} of night ${d.night}`).toBeGreaterThanOrEqual(want - TOL);
      expect(d.sec, `${d.phase} of night ${d.night}`).toBeLessThanOrEqual(want + TOL);
    }

    // Night events are forwarded.
    expect(counts.survived).toBe(NIGHT_COUNT);
    expect(counts.caught).toBe(0);
    expect(counts.start).toBeGreaterThanOrEqual(NIGHT_COUNT);
    expect(counts.leave).toBeGreaterThan(0);
    expect(flow.lastCaughtBy).toBeNull();
    expect(log.filter((l) => l.startsWith('!!'))).toEqual([]);

    // The ending has no timer.
    for (let i = 0; i < 72 * 30; i++) flow.update(DT, never);
    expect(flow.phase).toBe('ending');
    expect(changes).toHaveLength(expected.length);
  });

  it('is deterministic for a given rng seed', () => {
    const play = (seed: number) => {
      const { flow, log } = recordedFlow(seed);
      flow.begin();
      flow.completeIntro();
      for (let i = 0; i < 72 * 400 && flow.phase !== 'ending'; i++) {
        // Counter everything except during a short lapse every 20 s, to mix in catches.
        const t = i * DT;
        flow.update(DT, t % 20 < 19.5 ? always : never);
      }
      return log;
    };
    expect(play(3)).toEqual(play(3));
  });
});

describe('GameFlow: getting caught', () => {
  function toNight1(seed = 21) {
    const rec = recordedFlow(seed);
    rec.flow.begin();
    rec.flow.completeIntro();
    runPhase(rec.flow, never); // nightIntro -> night
    expect(rec.flow.phase).toBe('night');
    return rec;
  }

  it('caught -> pauses caught.pauseSec -> restarts the same night with the short intro', () => {
    const { flow, changes, counts, caughtIds } = toNight1();
    const firstRunner = flow.runner;

    runPhase(flow, never); // night -> caught (night 1 = Under the Desk, alone)
    expect(flow.phase).toBe('caught');
    expect(flow.night).toBe(1);
    expect(flow.lastCaughtBy).toBe('underDesk');
    expect(counts.caught).toBe(1);
    expect(caughtIds).toEqual(['underDesk']);
    expect(last(changes)).toEqual({ phase: 'caught', night: 1, prev: 'night' });

    const pause = runPhase(flow, never);
    expect(pause).toBeGreaterThanOrEqual(CONFIG.caught.pauseSec - TOL);
    expect(pause).toBeLessThanOrEqual(CONFIG.caught.pauseSec + TOL);
    expect(flow.phase).toBe('nightIntro');
    expect(flow.night).toBe(1);
    expect(flow.restarts).toBe(1);
    expect(last(changes)).toEqual({ phase: 'nightIntro', night: 1, prev: 'caught' });

    const intro = runPhase(flow, never);
    expect(intro).toBeGreaterThanOrEqual(CONFIG.flow.restartIntroSec - TOL);
    expect(intro).toBeLessThanOrEqual(CONFIG.flow.restartIntroSec + TOL);
    expect(flow.phase).toBe('night');
    expect(flow.night).toBe(1);
    expect(flow.runner).not.toBeNull();
    expect(flow.runner).not.toBe(firstRunner);
    expect(flow.runner!.state).toBe('running');
    expect(flow.runner!.elapsedSec).toBeLessThan(DT + 1e-6);
    expect(flow.runner!.tuning.night).toBe(1);
    expect(counts.caught).toBe(1);
  });

  it('counts each restart of the same night, and resets the count on the next night', () => {
    const { flow, changes } = toNight1();
    for (let k = 1; k <= 3; k++) {
      runPhase(flow, never); // night -> caught
      expect(flow.phase).toBe('caught');
      runPhase(flow, never); // caught -> nightIntro
      expect(flow.phase).toBe('nightIntro');
      expect(flow.restarts).toBe(k);
      runPhase(flow, never); // nightIntro -> night
      expect(flow.phase).toBe('night');
      expect(flow.night).toBe(1);
    }

    // Now survive night 1.
    const nightSec = runPhase(flow, always);
    expect(nightSec).toBeGreaterThanOrEqual(nightTuning(1).lengthSec - TOL);
    expect(flow.phase).toBe('nightCleared');
    expect(flow.night).toBe(1);
    expect(last(changes)).toEqual({ phase: 'nightCleared', night: 1, prev: 'night' });

    const cleared = runPhase(flow, always);
    expect(cleared).toBeGreaterThanOrEqual(CONFIG.flow.nightClearedSec - TOL);
    expect(cleared).toBeLessThanOrEqual(CONFIG.flow.nightClearedSec + TOL);
    expect(flow.phase).toBe('nightIntro');
    expect(flow.night).toBe(2);
    expect(flow.restarts).toBe(0);
    expect(last(changes)).toEqual({ phase: 'nightIntro', night: 2, prev: 'nightCleared' });

    // A first attempt at a night uses the full intro.
    const intro = runPhase(flow, always);
    expect(intro).toBeGreaterThanOrEqual(CONFIG.flow.nightIntroSec - TOL);
    expect(intro).toBeLessThanOrEqual(CONFIG.flow.nightIntroSec + TOL);
    expect(flow.runner!.tuning.night).toBe(2);
  });

  it('lastCaughtBy names the threat that caught the player', () => {
    // Night 3 introduces the Listener: never countering, its teaching attack catches first.
    const { flow, caughtIds } = recordedFlow(5);
    flow.debugJumpToNight(3);
    runPhase(flow, never);
    runPhase(flow, never);
    expect(flow.phase).toBe('caught');
    expect(flow.lastCaughtBy).toBe('listener');
    expect(caughtIds).toEqual(['listener']);
  });
});

describe('GameFlow: debugJumpToNight', () => {
  it('jumps from the title to any night intro', () => {
    for (let n = 1; n <= NIGHT_COUNT; n++) {
      const { flow, changes } = recordedFlow();
      flow.debugJumpToNight(n);
      expect(flow.phase).toBe('nightIntro');
      expect(flow.night).toBe(n);
      expect(changes).toEqual([{ phase: 'nightIntro', night: n, prev: 'title' }]);
      const intro = runPhase(flow, always);
      expect(intro).toBeGreaterThanOrEqual(CONFIG.flow.nightIntroSec - TOL);
      expect(intro).toBeLessThanOrEqual(CONFIG.flow.nightIntroSec + TOL);
      expect(flow.phase).toBe('night');
      expect(flow.runner!.tuning.night).toBe(n);
    }
  });

  it('jumps from the middle of a night, abandoning its runner', () => {
    const { flow, changes, log } = recordedFlow(9);
    flow.debugJumpToNight(2);
    runPhase(flow, always); // -> night 2
    for (let i = 0; i < 72 * 30; i++) flow.update(DT, always);
    expect(flow.phase).toBe('night');
    const old = flow.runner as NightRunnerLike;
    const oldElapsed = old.elapsedSec;

    const before = log.length;
    flow.debugJumpToNight(5);
    expect(flow.phase).toBe('nightIntro');
    expect(flow.night).toBe(5);
    expect(last(changes)).toEqual({ phase: 'nightIntro', night: 5, prev: 'night' });

    // The old night no longer runs during the intro: no attack events, no clock.
    for (let i = 0; i < 72 * 2; i++) flow.update(DT, never);
    expect(log.slice(before + 1)).toEqual([]);
    expect(old.elapsedSec).toBe(oldElapsed);

    runPhase(flow, always);
    expect(flow.phase).toBe('night');
    expect(flow.runner).not.toBe(old);
    expect(flow.runner!.tuning.night).toBe(5);
  });

  it('jumps from caught, nightCleared and ending', () => {
    // caught
    const a = recordedFlow(1);
    a.flow.debugJumpToNight(1);
    runPhase(a.flow, never);
    runPhase(a.flow, never);
    expect(a.flow.phase).toBe('caught');
    a.flow.debugJumpToNight(4);
    expect(a.flow.phase).toBe('nightIntro');
    expect(a.flow.night).toBe(4);
    expect(last(a.changes)).toEqual({ phase: 'nightIntro', night: 4, prev: 'caught' });

    // nightCleared
    const b = recordedFlow(2);
    b.flow.debugJumpToNight(1);
    runPhase(b.flow, always);
    runPhase(b.flow, always);
    expect(b.flow.phase).toBe('nightCleared');
    b.flow.debugJumpToNight(3);
    expect(b.flow.phase).toBe('nightIntro');
    expect(b.flow.night).toBe(3);
    expect(last(b.changes)).toEqual({ phase: 'nightIntro', night: 3, prev: 'nightCleared' });

    // ending
    const c = recordedFlow(3);
    c.flow.debugJumpToNight(NIGHT_COUNT);
    runPhase(c.flow, always);
    runPhase(c.flow, always);
    expect(c.flow.phase).toBe('ending');
    expect(last(c.changes)).toEqual({ phase: 'ending', night: NIGHT_COUNT, prev: 'night' });
    c.flow.debugJumpToNight(2);
    expect(c.flow.phase).toBe('nightIntro');
    expect(c.flow.night).toBe(2);
    expect(last(c.changes)).toEqual({ phase: 'nightIntro', night: 2, prev: 'ending' });
    runPhase(c.flow, always);
    expect(c.flow.runner!.tuning.night).toBe(2);
  });
});
