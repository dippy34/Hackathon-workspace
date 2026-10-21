// Leaving XR mid-night pauses; re-entering replays that night from its start.
// Leaving during "Night N survived." resumes at night N+1.
import { launch, until, sleep } from './harness.mjs';
import { enterAndCalibrate } from './flow.mjs';
import { installAutopilot } from './autopilot.mjs';

const t = await launch({ url: process.argv[2] });
const { page, state, shot } = t;
const out = { ok: false };
const exitXR = () => page.evaluate(() => window.IWER_DEVICE.activeSession.end());
const reenter = async () => {
  await until(() => page.isVisible('[data-role=enter]'), { label: 'title shown again' });
  out.resumeLine = await page.evaluate(() => document.getElementById('title-root')?.innerText.match(/Resume:[^\n]*/)?.[0] ?? null);
  await page.click('[data-role=enter]');
  await until(() => page.evaluate(() => !!window.IWER_DEVICE.activeSession), { label: 'XR again' });
  await installAutopilot(page);
};
try {
  await enterAndCalibrate(t);
  await page.evaluate(() => window.__holdStill.jumpToNight(2));
  await until(async () => (await state()).phase === 'night', { label: 'night 2', timeoutMs: 120000 });
  await sleep(5000);
  await exitXR();
  await reenter();
  out.midNight = { ...(await state()), resumeLine: out.resumeLine };
  out.midNightOk = out.midNight.night === 2 && out.midNight.phase === 'nightIntro';
  // Survive-break resume: force the nightCleared phase by jumping to the end of night 2's clock.
  await until(async () => (await state()).phase === 'night', { label: 'night 2 again', timeoutMs: 120000 });
  await page.evaluate(() => { const r = window.__holdStill.flow.runner; r._elapsed = r.tuning.lengthSec - 0.5; });
  await until(async () => (await state()).phase === 'nightCleared', { label: 'nightCleared', timeoutMs: 60000 });
  await exitXR();
  await reenter();
  out.afterCleared = { ...(await state()), resumeLine: out.resumeLine };
  out.afterClearedOk = out.afterCleared.night === 3;
  await shot('resume-after-cleared');
  out.ok = out.midNightOk && out.afterClearedOk;
} catch (e) {
  out.error = String(e);
  try { out.state = await state(); await shot('resume-failure'); } catch {}
} finally {
  out.errors = t.logs.filter((l) => l.startsWith('[error]') || l.startsWith('[pageerror]')).slice(0, 20);
  await t.close();
  for (const k of ['midNight', 'afterCleared']) if (out[k]) delete out[k].report;
  console.log(JSON.stringify(out, null, 2));
  process.exitCode = out.ok && out.errors.length === 0 ? 0 : 1;
}
