// The M1 "done when" in the emulator: play all 5 nights start to finish, hands
// only (emulated), with an ideal-player autopilot. Expect: never caught, and the
// ending ("You held still.") is reached. Logs every phase change and attack.
import { launch, until, sleep } from './harness.mjs';
import { enterAndCalibrate } from './flow.mjs';

const t = await launch({ url: process.argv[2] });
const { page, state, shot } = t;
const out = { phases: [], ok: false };
const t0 = Date.now();
try {
  await enterAndCalibrate(t);
  let last = '';
  let maxConcurrent = 0;
  const seen = new Set();
  for (;;) {
    const s = await state();
    const key = `${s.phase}:${s.night}`;
    if (key !== last) {
      out.phases.push({ t: Math.round((Date.now() - t0) / 1000), phase: s.phase, night: s.night, restarts: s.restarts, lastCaughtBy: s.lastCaughtBy });
      console.log(JSON.stringify(out.phases.at(-1)));
      if (s.phase === 'night' && !seen.has(s.night)) { seen.add(s.night); await sleep(20000); await shot(`full-night${s.night}`); }
      last = key;
    }
    maxConcurrent = Math.max(maxConcurrent, s.active?.length ?? 0);
    if (s.phase === 'ending') break;
    if (Date.now() - t0 > 75 * 60 * 1000) throw new Error('took too long');
    await sleep(500);
  }
  await sleep(4000);
  out.endShot = await shot('full-ending');
  out.final = await state();
  out.maxConcurrent = maxConcurrent;
  out.decisions = await page.evaluate(() => window.__autopilot.decisions);
  out.caughtCount = out.phases.filter((p) => p.phase === 'caught').length;
  out.ok = out.caughtCount === 0;
} catch (e) {
  out.error = String(e);
  try { out.state = await state(); await shot('full-failure'); } catch {}
} finally {
  out.errors = t.logs.filter((l) => l.startsWith('[error]') || l.startsWith('[pageerror]')).slice(0, 20);
  out.minutes = +((Date.now() - t0) / 60000).toFixed(1);
  await t.close();
  console.log(JSON.stringify(out, null, 2));
  process.exitCode = out.ok && out.errors.length === 0 ? 0 : 1;
}
