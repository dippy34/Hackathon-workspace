// Shared: get from the title page through the intro into night 1 with the autopilot.
import { installHelpers, quat, until, sleep } from './harness.mjs';
import { installAutopilot } from './autopilot.mjs';

export async function enterAndCalibrate(t) {
  const { page, state } = t;
  await page.click('[data-role=begin]');
  await until(async () => !['idle', 'requesting'].includes((await state()).mic), { label: 'mic' });
  await until(() => page.isEnabled('[data-role=enter]'), { label: 'enter enabled' });
  await page.click('[data-role=enter]');
  await until(() => page.evaluate(() => !!window.IWER_DEVICE.activeSession), { label: 'XR session' });
  await installHelpers(page);
  await page.evaluate((qh) => { __e2e.hands(); __e2e.head([0, 1.2, 0], qh); }, quat(0, -20));
  await installAutopilot(page);
  await until(async () => !(await state()).intro.startsWith('calibrating'), { label: 'calibration', timeoutMs: 180000 });
  const s = await state();
  if (s.phase === 'intro' && s.doors === 0) {
    await until(async () => ['placeDoor', 'placeWindow'].includes((await state()).intro), { label: 'placement', timeoutMs: 60000 });
    await page.evaluate(() => (window.__autopilot.enabled = false));
    await page.evaluate((q) => __e2e.hand('right', [0.2, 1.0, -0.3], q, 'default'), quat(-90, 0));
    await sleep(2500);
    await page.evaluate(() => __e2e.pinch('right', 1));
    await sleep(1500);
    await page.evaluate(() => __e2e.pinch('right', 0));
    await page.evaluate(() => (window.__autopilot.enabled = true));
  }
  await until(async () => (await state()).phase !== 'intro', { label: 'intro done', timeoutMs: 90000 });
}
