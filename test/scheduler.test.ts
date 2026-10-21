/**
 * The fairness budget (src/core/scheduler.ts handsBusySec / passesFairness)
 * term by term, and NightRunner's frame handling: the hitch clamp
 * (MAX_FRAME_SEC) and dispose().
 */

import { describe, expect, it } from 'vitest';
import { CONFIG, nightTuning, type ThreatId } from '../src/config.js';
import { MAX_FRAME_SEC, NightRunner } from '../src/core/night-runner.js';
import { mulberry32 } from '../src/core/rng.js';
import { handsBusySec, passesFairness } from '../src/core/scheduler.js';
import type { AttackView } from '../src/core/types.js';
import { EPS, SIM_DT, effectiveCaughtAfterSec } from './sim/player.js';

const R = CONFIG.scheduler.reactionSec;
const T = CONFIG.threats;

/** A stand-in AttackView for the pure fairness functions. */
function view(id: ThreatId, opts: { remainingLeaveSec?: number; countering?: boolean } = {}): AttackView {
  const rem = opts.remainingLeaveSec ?? T[id].leavesAfterSec;
  return {
    id,
    meter: 0,
    counteredSec: T[id].leavesAfterSec - rem,
    remainingLeaveSec: rem,
    ageSec: 0.1,
    state: 'active',
    teaching: false,
    countering: opts.countering ?? false,
  };
}

describe('handsBusySec: the fairness budget', () => {
  it('is 0 with nothing active and no recent hands leave', () => {
    expect(handsBusySec([])).toBe(0);
    expect(handsBusySec([], 10)).toBe(0);
  });

  it('one countered hands-attack: exactly DESIGN.md (remaining "leaves after" + 1.5 s)', () => {
    expect(handsBusySec([view('underDesk', { remainingLeaveSec: 4, countering: true })])).toBeCloseTo(4 + R, 12);
  });

  it('adds one more reaction while no active hands-attack is being countered yet', () => {
    const fresh = view('underDesk', { countering: false });
    expect(handsBusySec([fresh])).toBeCloseTo(T.underDesk.leavesAfterSec + 2 * R, 12);
    // One countered attack is enough: the player is working through the queue.
    const two = [view('knocker', { remainingLeaveSec: 1, countering: true }), view('peeker', { countering: false })];
    expect(handsBusySec(two)).toBeCloseTo(1 + R + T.peeker.leavesAfterSec + R, 12);
    const none = [view('knocker', { remainingLeaveSec: 1 }), view('peeker')];
    expect(handsBusySec(none)).toBeCloseTo(1 + R + T.peeker.leavesAfterSec + R + R, 12);
  });

  it('ignores the Listener, countered or not', () => {
    expect(handsBusySec([view('listener')])).toBe(0);
    expect(handsBusySec([view('listener', { countering: true }), view('peeker', { countering: true })])).toBeCloseTo(
      T.peeker.leavesAfterSec + R,
      12,
    );
  });

  it('hand-off: right after a hands-attack leaves the budget is reactionSec - time since, and continuous', () => {
    expect(handsBusySec([], 0)).toBeCloseTo(R, 12);
    expect(handsBusySec([], 0.5)).toBeCloseTo(R - 0.5, 12);
    expect(handsBusySec([], R)).toBe(0);
    expect(handsBusySec([], R + 3)).toBe(0);
    // One substep before the leave, the countered attack with ~0 left read the same.
    expect(handsBusySec([view('peeker', { remainingLeaveSec: 0, countering: true })])).toBeCloseTo(handsBusySec([], 0), 12);
    // While a hands-attack is active its own term already covers a returning hand.
    expect(handsBusySec([view('knocker', { remainingLeaveSec: 0.2, countering: true })], 0)).toBeCloseTo(0.2 + R, 12);
  });
});

describe('passesFairness', () => {
  it('night 2: a Peeker may not join an untouched Under the Desk, but may once it is being countered', () => {
    const ag = nightTuning(2).aggression;
    // 8 s > 6 s + 1.5 s, but nobody is countering the desk yet: 8 s < 6 + 1.5 + 1.5.
    expect(passesFairness('peeker', ag, [view('underDesk', { remainingLeaveSec: 6, countering: false })])).toBe(false);
    expect(passesFairness('peeker', ag, [view('underDesk', { remainingLeaveSec: 6, countering: true })])).toBe(true);
  });

  it('night 5: Under the Desk waits out the hand-off after a hands-attack leaves', () => {
    const ag = nightTuning(5).aggression;
    const eff = effectiveCaughtAfterSec('underDesk', ag); // 0.9375 s
    const wait = R - eff; // 0.5625 s
    expect(passesFairness('underDesk', ag, [], 0)).toBe(false);
    expect(passesFairness('underDesk', ag, [], wait - 0.01)).toBe(false);
    expect(passesFairness('underDesk', ag, [], wait + 0.01)).toBe(true);
    expect(passesFairness('underDesk', ag, [])).toBe(true);
  });

  it('the Listener always passes', () => {
    expect(passesFairness('listener', 1.6, [view('underDesk'), view('peeker')], 0)).toBe(true);
  });
});

describe('NightRunner frame handling', () => {
  it('clamps a long frame to MAX_FRAME_SEC (time slows during a hitch)', () => {
    const runner = new NightRunner(nightTuning(1), mulberry32(1));
    runner.update(5, () => true);
    expect(runner.elapsedSec).toBeCloseTo(MAX_FRAME_SEC, 12);
    runner.update(Infinity, () => true);
    expect(runner.elapsedSec).toBeCloseTo(2 * MAX_FRAME_SEC, 12);
    runner.update(NaN, () => true);
    runner.update(-1, () => true);
    expect(runner.elapsedSec).toBeCloseTo(2 * MAX_FRAME_SEC, 12);
  });

  it('MAX_FRAME_SEC is shorter than every effective "caught after" in the shipped nights', () => {
    for (const n of CONFIG.nights) {
      for (const id of n.threats) expect(effectiveCaughtAfterSec(id, n.aggression)).toBeGreaterThan(MAX_FRAME_SEC);
    }
  });

  it.each([3, 4, 5])(
    'night %i: a 1 s hitch as Under the Desk comes due cannot start it and catch in the same update',
    (night) => {
      let armed = false;
      for (let seed = 0; seed < 200 && !armed; seed++) {
        const events: string[] = [];
        let inHitch = false;
        const runner = new NightRunner(nightTuning(night), mulberry32(seed), {
          onAttackStart: (a) => inHitch && events.push(`start ${a.id}`),
          onCaught: (a) => inHitch && events.push(`caught ${a.id}`),
        });
        // Perfect play until Under the Desk is due within one frame with nothing active.
        while (runner.state === 'running') {
          const next = runner.nextAttackInSec('underDesk');
          if (next !== null && next > 0 && next < SIM_DT && runner.activeAttacks().length === 0) {
            armed = true;
            break;
          }
          runner.update(SIM_DT, () => true);
        }
        if (!armed) continue;
        const before = runner.elapsedSec;
        inHitch = true;
        // Input sampled before the frame: hands not flat.
        runner.update(1.0, (id) => id !== 'underDesk');
        expect(events).toEqual(['start underDesk']);
        expect(runner.state).toBe('running');
        expect(runner.elapsedSec - before).toBeCloseTo(MAX_FRAME_SEC, 9);
        const desk = runner.activeAttacks().find((a) => a.id === 'underDesk')!;
        expect(desk.meter).toBeLessThan(0.2);
      }
      expect(armed).toBe(true);
    },
  );

  it('dispose() inside an event handler stops the rest of that update and every later one', () => {
    let fired = 0;
    let atDispose = -1;
    const runner: NightRunner = new NightRunner(nightTuning(5), mulberry32(3), {
      onAttackStart: () => {
        fired++;
        atDispose = runner.elapsedSec;
        runner.dispose();
      },
      onAttackLeave: () => fired++,
      onCaught: () => fired++,
      onSurvived: () => fired++,
    });
    // Step until the first attack is due within one substep, then take a full-length frame.
    while (fired === 0) {
      const due = Math.min(...nightTuning(5).threats.map((id) => runner.nextAttackInSec(id) ?? Infinity));
      if (due > 0 && due < 1 / 60) runner.update(MAX_FRAME_SEC, () => false);
      else runner.update(SIM_DT, () => false);
    }
    expect(fired).toBe(1);
    expect(runner.elapsedSec).toBeCloseTo(atDispose, 12); // no further substeps ran
    for (let i = 0; i < 200; i++) runner.update(MAX_FRAME_SEC, () => false);
    expect(fired).toBe(1);
    expect(runner.elapsedSec).toBeCloseTo(atDispose, 12);
    expect(runner.state).toBe('running');
    expect(Math.abs(runner.elapsedSec - atDispose)).toBeLessThan(EPS);
  });
});
