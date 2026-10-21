// Each threat can catch you, and a catch restarts the same night.
// For each threat X: jump to the night X is introduced, let the autopilot counter
// everything except X, and expect: caught by X -> 'caught' -> same night restarts.
import { launch, until, sleep } from './harness.mjs';
import { enterAndCalibrate } from './flow.mjs';
import { setNoisy } from './autopilot.mjs';

const CASES = [
  { id: 'underDesk', night: 1 },
  { id: 'peeker', night: 2 },
  { id: 'listener', night: 3 },
  { id: 'knocker', night: 4 },
];
const t = await launch({ url: process.argv[2] });
const { page, state, shot } = t;
const results = [];
try {
  await enterAndCalibrate(t);
  for (const c of CASES) {
    await page.evaluate((id) => (window.__autopilot.ignore = [id]), c.id);
    await setNoisy(page, c.id === 'listener');
    await page.evaluate((n) => window.__holdStill.jumpToNight(n), c.night);
    const r = { ...c };
    try {
      await until(async () => (await state()).phase === 'night', { label: 'night', timeoutMs: 120000 });
      await until(async () => { const s = await state(); return s.active?.some((a) => a.id === c.id); }, { label: `${c.id} attack`, timeoutMs: 240000 });
      await sleep(800);
      r.attackShot = await shot(`caught-${c.id}-attack`);
      await until(async () => (await state()).phase === 'caught', { label: 'caught', timeoutMs: 240000 });
      r.caughtBy = (await state()).lastCaughtBy;
      await sleep(300);
      r.caughtShot = await shot(`caught-${c.id}-moment`);
      await until(async () => (await state()).phase === 'nightIntro', { label: 'restart', timeoutMs: 120000 });
      const s = await state();
      r.restartNight = s.night;
      r.restarts = s.restarts;
      r.ok = r.caughtBy === c.id && r.restartNight === c.night && r.restarts >= 1;
    } catch (e) {
      r.ok = false; r.error = String(e); r.state = await state();
      await shot(`caught-${c.id}-failure`);
    }
    results.push(r);
    console.log(JSON.stringify(r));
  }
} finally {
  await setNoisy(page, false).catch(() => {});
  const errors = t.logs.filter((l) => l.startsWith('[error]') || l.startsWith('[pageerror]')).slice(0, 20);
  await t.close();
  const ok = results.length === CASES.length && results.every((r) => r.ok) && errors.length === 0;
  console.log(JSON.stringify({ ok, errors }, null, 2));
  process.exitCode = ok ? 0 : 1;
}
