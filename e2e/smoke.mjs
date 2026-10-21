// Smoke test: title page -> mic -> enter XR -> intro calibration -> door placement -> night 1 begins.
// Usage: (dev server running: npx vite --port 8195) node e2e/smoke.mjs [url]
import { launch, installHelpers, quat, until, sleep } from './harness.mjs';

const t = await launch({ url: process.argv[2] });
const { page, shot, state } = t;
const result = { steps: {} };
try {
  result.steps.title = await shot('01-title');
  await page.click('[data-role=begin]');
  await until(async () => (await state()).mic !== 'idle' && (await state()).mic !== 'requesting', { label: 'mic' });
  result.steps.mic = (await state()).mic;
  await until(() => page.isEnabled('[data-role=enter]'), { label: 'enter enabled' });
  await page.click('[data-role=enter]');
  await until(() => page.evaluate(() => !!window.IWER_DEVICE.activeSession), { label: 'XR session' });
  await installHelpers(page);
  // Seated player, hands flat on a 0.75 m desk, palms down.
  await page.evaluate(([qh, qd]) => {
    __e2e.hands();
    __e2e.head([0, 1.2, 0], qh);
    __e2e.hand('left', [-0.18, 0.75, -0.4], qd, 'default');
    __e2e.hand('right', [0.18, 0.75, -0.4], qd, 'default');
  }, [quat(0, -20), quat(0, -30)]);
  await sleep(1500);
  result.steps.handsProbe = await page.evaluate(() => {
    const h = window.__holdStill.director.hands;
    const f = (s) => ({ tracked: s.tracked, palm: s.palm.toArray().map((n) => +n.toFixed(3)), normal: s.palmNormal.toArray().map((n) => +n.toFixed(2)), down: +s.palmDownAngleDeg.toFixed(1), speed: +s.speed.toFixed(3) });
    return { left: f(h.left), right: f(h.right) };
  });
  result.steps.intro0 = await shot('02-intro');
  await until(async () => !(await state()).intro.startsWith('calibrating'), { label: 'calibration', timeoutMs: 120000 });
  result.steps.afterCalibration = await state();
  result.steps.calibrated = await shot('03-calibrated');
  // living_room has windows but no door: the intro asks to place one. Point right hand at a wall and pinch.
  await until(async () => ['placeDoor', 'placeWindow', 'done'].includes((await state()).intro) || (await state()).phase !== 'intro', { label: 'placement step', timeoutMs: 60000 });
  result.steps.placementStep = (await state()).intro;
  if ((await state()).phase === 'intro') {
    await page.evaluate((q) => __e2e.hand('right', [0.2, 1.0, -0.3], q, 'default'), quat(-90, 0));
    await sleep(2500);
    result.steps.placing = await shot('04-placing');
    await page.evaluate(() => __e2e.pinch('right', 1));
    await sleep(1500);
    await page.evaluate(() => __e2e.pinch('right', 0));
    await sleep(1000);
  }
  await until(async () => (await state()).phase !== 'intro', { label: 'intro done', timeoutMs: 60000 });
  result.steps.afterIntro = await state();
  await sleep(4000);
  result.steps.nightIntro = await shot('05-night-intro');
  result.ok = true;
} catch (e) {
  result.ok = false;
  result.error = String(e?.stack || e);
  try { result.state = await state(); await shot('99-failure'); } catch {}
} finally {
  result.errors = t.logs.filter((l) => l.startsWith('[error]') || l.startsWith('[pageerror]')).slice(0, 20);
  await t.close();
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.ok && !result.errors.length ? 0 : 1;
}
