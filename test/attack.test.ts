/**
 * The danger meter (DESIGN.md "The threats"): fills while not countered
 * (dt * aggression / caughtAfterSec), drains while countered
 * (dt * meterDrainMultiplier / caughtAfterSec), catches when full, and leaves
 * after a cumulative leavesAfterSec of countering.
 */

import { describe, expect, it } from 'vitest';
import { CONFIG, THREAT_IDS, type ThreatId } from '../src/config.js';
import { Attack } from '../src/core/attack.js';

const DT = 1 / 72;
const AGGRESSIONS = [...new Set(CONFIG.nights.map((n) => n.aggression))];

function attack(id: ThreatId, aggression = 1, teaching = false): Attack {
  return new Attack(id, CONFIG.threats[id], aggression, teaching);
}

/** Runs `sec` seconds of updates in DT frames; returns the frames actually run. */
function run(a: Attack, sec: number, countering: boolean): number {
  const frames = Math.round(sec / DT);
  for (let i = 0; i < frames; i++) a.update(DT, countering);
  return frames;
}

/** Updates until the attack is no longer active; returns the elapsed seconds. */
function runUntilDone(a: Attack, countering: (t: number) => boolean, limitSec = 60): number {
  let t = 0;
  while (a.state === 'active' && t < limitSec) {
    a.update(DT, countering(t));
    t += DT;
  }
  return t;
}

describe('Attack: construction', () => {
  it('starts active with an empty meter', () => {
    const a = attack('peeker', 1.3, true);
    expect(a.id).toBe('peeker');
    expect(a.teaching).toBe(true);
    expect(a.state).toBe('active');
    expect(a.meter).toBe(0);
    expect(a.counteredSec).toBe(0);
    expect(a.ageSec).toBe(0);
    expect(a.countering).toBe(false);
    expect(a.remainingLeaveSec).toBe(CONFIG.threats.peeker.leavesAfterSec);
    expect(attack('knocker').teaching).toBe(false);
  });

  it.each(THREAT_IDS)('%s: effectiveCaughtAfterSec = caughtAfterSec / aggression', (id) => {
    for (const ag of AGGRESSIONS) {
      expect(attack(id, ag).effectiveCaughtAfterSec).toBeCloseTo(CONFIG.threats[id].caughtAfterSec / ag, 12);
    }
  });
});

describe('Attack: meter fill (not countering)', () => {
  it('fills at aggression / caughtAfterSec per second', () => {
    const a = attack('peeker', 1); // 8 s to catch
    a.update(2, false);
    expect(a.meter).toBeCloseTo(2 / 8, 12);
    const b = attack('peeker', 1.6);
    b.update(2, false);
    expect(b.meter).toBeCloseTo((2 * 1.6) / 8, 12);
    expect(b.ageSec).toBeCloseTo(2, 12);
    expect(b.counteredSec).toBe(0);
    expect(b.countering).toBe(false);
    expect(b.state).toBe('active');
  });

  it.each(THREAT_IDS)('%s: caught after caughtAfterSec / aggression of not countering', (id) => {
    for (const ag of AGGRESSIONS) {
      const eff = CONFIG.threats[id].caughtAfterSec / ag;
      const a = attack(id, ag);
      const t = runUntilDone(a, () => false);
      expect(a.state).toBe('caught');
      expect(a.meter).toBe(1);
      expect(t).toBeGreaterThanOrEqual(eff - 1e-9);
      expect(t).toBeLessThanOrEqual(eff + DT + 1e-9);
      expect(a.ageSec).toBeCloseTo(t, 9);
    }
  });

  it('is still active just before the meter is full', () => {
    const a = attack('knocker', 1.3); // 5 / 1.3 = 3.846 s
    a.update(5 / 1.3 - 0.01, false);
    expect(a.state).toBe('active');
    expect(a.meter).toBeLessThan(1);
    a.update(0.02, false);
    expect(a.state).toBe('caught');
  });

  it('is caught when the meter reaches exactly 1', () => {
    const a = attack('underDesk', 1);
    a.update(1.5, false);
    expect(a.state).toBe('caught');
    expect(a.meter).toBe(1);
  });

  it('a huge dt clamps the meter at 1 and catches', () => {
    const a = attack('peeker', 1);
    a.update(1000, false);
    expect(a.state).toBe('caught');
    expect(a.meter).toBe(1);
  });
});

describe('Attack: meter drain (countering)', () => {
  it('drains at meterDrainMultiplier / caughtAfterSec per second, independent of aggression', () => {
    for (const ag of AGGRESSIONS) {
      const a = attack('peeker', ag);
      a.update(4 / ag, false); // meter 0.5
      expect(a.meter).toBeCloseTo(0.5, 9);
      a.update(1, true);
      expect(a.meter).toBeCloseTo(0.5 - (1 * CONFIG.meterDrainMultiplier) / 8, 9);
      expect(a.countering).toBe(true);
    }
  });

  it('never drains below 0', () => {
    const a = attack('knocker', 1);
    a.update(0.5, false);
    a.update(3.9, true);
    expect(a.meter).toBe(0);
    const b = attack('listener', 1);
    b.update(1, true);
    expect(b.meter).toBe(0);
  });

  it('the countering flag records the last update', () => {
    const a = attack('peeker');
    a.update(DT, true);
    expect(a.countering).toBe(true);
    a.update(DT, false);
    expect(a.countering).toBe(false);
  });

  it('ageSec counts countered and uncountered time; counteredSec only countered time', () => {
    const a = attack('peeker');
    a.update(1, false);
    a.update(0.5, true);
    a.update(0.25, false);
    expect(a.ageSec).toBeCloseTo(1.75, 12);
    expect(a.counteredSec).toBeCloseTo(0.5, 12);
  });
});

describe('Attack: leaving', () => {
  it.each(THREAT_IDS)('%s: leaves after leavesAfterSec of continuous countering', (id) => {
    const leaves = CONFIG.threats[id].leavesAfterSec;
    for (const ag of AGGRESSIONS) {
      const a = attack(id, ag);
      const t = runUntilDone(a, () => true);
      expect(a.state).toBe('left');
      expect(t).toBeGreaterThanOrEqual(leaves - 1e-9);
      expect(t).toBeLessThanOrEqual(leaves + DT + 1e-9);
      expect(a.remainingLeaveSec).toBe(0);
      expect(a.meter).toBe(0);
    }
  });

  it('countered time is cumulative across interruptions', () => {
    // Knocker: 5 s to catch, 4 s to leave. Alternate 1 s countering / 0.5 s not.
    const a = attack('knocker', 1);
    for (let i = 0; i < 3; i++) {
      run(a, 1, true);
      run(a, 0.5, false);
    }
    expect(a.state).toBe('active');
    expect(a.counteredSec).toBeCloseTo(3, 6);
    expect(a.ageSec).toBeCloseTo(4.5, 6);
    expect(a.remainingLeaveSec).toBeCloseTo(1, 6);
    const t = runUntilDone(a, () => true);
    expect(a.state).toBe('left');
    expect(t).toBeGreaterThanOrEqual(1 - 1e-6);
    expect(t).toBeLessThanOrEqual(1 + DT + 1e-6);
  });

  it('leaving depends only on countered time, not on the meter', () => {
    // Under the Desk at 1.6x: fill most of the meter, then counter. It still leaves after 6 s countered.
    const a = attack('underDesk', 1.6);
    a.update(0.8, false); // meter 0.853
    expect(a.meter).toBeGreaterThan(0.8);
    a.update(CONFIG.threats.underDesk.leavesAfterSec - 0.001, true);
    expect(a.state).toBe('active');
    a.update(0.002, true);
    expect(a.state).toBe('left');
  });

  it('leaves exactly when counteredSec reaches leavesAfterSec', () => {
    const a = attack('peeker');
    a.update(2.5, true);
    expect(a.state).toBe('left');
    const b = attack('peeker');
    b.update(2.49, true);
    expect(b.state).toBe('active');
  });

  it('a huge countered dt leaves (never catches)', () => {
    const a = attack('listener', 1.6);
    a.update(1000, true);
    expect(a.state).toBe('left');
    expect(a.meter).toBe(0);
    expect(a.remainingLeaveSec).toBe(0);
  });
});

describe('Attack: remainingLeaveSec', () => {
  it('is max(0, leavesAfterSec - counteredSec)', () => {
    const a = attack('underDesk'); // leaves after 6 s
    expect(a.remainingLeaveSec).toBe(6);
    a.update(0.5, false);
    expect(a.remainingLeaveSec).toBe(6); // uncountered time does not count
    a.update(0.2, true);
    expect(a.remainingLeaveSec).toBeCloseTo(5.8, 12);
    a.update(2, true);
    expect(a.remainingLeaveSec).toBeCloseTo(3.8, 12);
    a.update(10, true);
    expect(a.remainingLeaveSec).toBe(0);
  });
});

describe('Attack: finished attacks are frozen', () => {
  it('a caught attack ignores further updates', () => {
    const a = attack('underDesk');
    a.update(2, false);
    expect(a.state).toBe('caught');
    const snap = { meter: a.meter, ageSec: a.ageSec, counteredSec: a.counteredSec, countering: a.countering };
    a.update(1, true);
    a.update(1, false);
    expect(a.state).toBe('caught');
    expect({ meter: a.meter, ageSec: a.ageSec, counteredSec: a.counteredSec, countering: a.countering }).toEqual(snap);
  });

  it('a left attack ignores further updates', () => {
    const a = attack('peeker');
    a.update(3, true);
    expect(a.state).toBe('left');
    const snap = { meter: a.meter, ageSec: a.ageSec, counteredSec: a.counteredSec, countering: a.countering };
    a.update(100, false);
    expect(a.state).toBe('left');
    expect({ meter: a.meter, ageSec: a.ageSec, counteredSec: a.counteredSec, countering: a.countering }).toEqual(snap);
  });
});
