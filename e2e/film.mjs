// Directed recording of the monsters in the emulator (no sound: Playwright video is silent).
// Usage: node e2e/film.mjs <outDir> [url]  (records a silent .webm; convert with ffmpeg)
import { launch, quat, sleep } from './harness.mjs';
import { enterAndCalibrate } from './flow.mjs';

const OUT = process.argv[2];
const t = await launch({ url: process.argv[3] || 'https://localhost:8195/?debug=1', outDir: OUT, video: OUT, viewport: { width: 960, height: 540 } });
const { page } = t;
const SEAT = [0, 1.2, 0];
const aim = (from, to) => { const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2]; return quat((Math.atan2(-dx, -dz) * 180) / Math.PI, (Math.atan2(dy, Math.hypot(dx, dz)) * 180) / Math.PI); };
const look = (from, to) => page.evaluate(([p, q]) => __e2e.head(p, q), [from, aim(from, to)]);
const caption = (text) => page.evaluate((text) => {
  let el = document.getElementById('film-cap');
  if (!el) { el = document.createElement('div'); el.id = 'film-cap'; el.style.cssText = 'position:fixed;left:0;right:0;bottom:22px;text-align:center;z-index:99999;font:600 22px Georgia,serif;color:#eee6d6;text-shadow:0 2px 6px #000,0 0 2px #000;pointer-events:none'; document.body.appendChild(el); }
  el.textContent = text;
}, text);
const threat = (id, meter) => page.evaluate(([id, meter]) => {
  const d = window.__holdStill.director, P = d.threats[id];
  for (const k of Object.keys(d.threats)) d.threats[k].reset();
  const attack = { id, meter, countering: false, teaching: false, ageSec: 3, counteredSec: 0, remainingLeaveSec: 5, state: 'active' };
  P.begin(attack, d.ctx);
  clearInterval(window.__filmTimer);
  window.__filmAttack = attack;
  window.__filmTimer = setInterval(() => { attack.ageSec += 0.04; P.update(attack, d.ctx); }, 40);
  const v = id === 'peeker' ? P.facePos : id === 'knocker' ? P.doorTarget : P.root.getWorldPosition(P.root.position.clone());
  return [v.x, v.y, v.z];
}, [id, meter]);
const ramp = async (from, to, sec, countering = false) => {
  const n = Math.round(sec * 5);
  for (let i = 0; i <= n; i++) { await page.evaluate(([m, c]) => { window.__filmAttack.meter = m; window.__filmAttack.countering = c; }, [from + ((to - from) * i) / n, countering]); await sleep(200); }
};
const caught = async (id, night) => {
  await page.evaluate((id) => { clearInterval(window.__filmTimer); const d = window.__holdStill.director; d.threats[id].caught(d.ctx); }, id);
  await sleep(1900);
  await page.evaluate((night) => { const d = window.__holdStill.director; d.darkness.fadeTo(1, 0.08); for (const k of Object.keys(d.threats)) d.threats[k].hideVisuals(); d.text.show(`Night ${night}`, { mode: 'gaze', size: 0.09, subtitle: 'Again.', fadeInSec: 0.1 }); }, night);
  await sleep(2500);
  await page.evaluate(() => { const d = window.__holdStill.director; for (const k of Object.keys(d.threats)) d.threats[k].reset(); d.text.hide(0.3); d.darkness.fadeTo(0.94, 0.5); });
  await sleep(1200);
};
const hands = (side, p, q, pinch) => page.evaluate(([side, p, q, pinch]) => { const h = window.IWER_DEVICE.hands[side]; h.position.set(...p); h.quaternion.set(...q); h.updatePinchValue(pinch); }, [side, p, q, pinch]);
const flat = quat(0, -30);

try {
  await caption('HOLD STILL: desktop emulator recording (no sound)');
  await sleep(3500);
  await caption('Seated at your desk. Hands only.');
  await enterAndCalibrate(t);
  await caption('Night 1');
  await sleep(5000);
  await page.evaluate(() => { const d = window.__holdStill.director; window.__autopilot.enabled = false; d.flow.update = () => {}; d.overlay.setVisible(false); d.room.setMarkersVisible(false); d.text.hide(0.2); d.darkness.fadeTo(0.94, 0.01); });
  await hands('left', [-0.18, 0.75, -0.4], flat, 0); await hands('right', [0.18, 0.75, -0.4], flat, 0);

  // Under the Desk
  const ud = await threat('underDesk', 0.15);
  await look(SEAT, [ud[0], 0.72, ud[2] + 0.2]);
  await caption('Scratching under the desk...');
  await ramp(0.15, 0.6, 6);
  await caption('Under the Desk: keep both hands flat, or it comes for you');
  await ramp(0.6, 0.97, 5);
  await caption('');
  await caught('underDesk', 1);

  // Peeker
  const pk = await threat('peeker', 0.2);
  await look(SEAT, pk);
  await caption('Tapping on the window glass...');
  await ramp(0.2, 0.55, 6);
  await caption('The Peeker: pinch for your flashlight and hold the beam on it');
  await hands('right', [0.2, 1.0, -0.3], aim([0.2, 1.0, -0.3], pk), 1);
  await ramp(0.55, 0.45, 4, true);
  await hands('right', [0.18, 0.75, -0.4], flat, 0);
  await caption('...but if your battery dies, it comes through the glass');
  await ramp(0.45, 0.97, 6);
  await caption('');
  await caught('peeker', 2);

  // Knocker
  const kn = await threat('knocker', 0.2);
  await look(SEAT, kn);
  await caption('Your door handle rattles. Then knocking.');
  await ramp(0.2, 0.6, 6);
  await caption('The Knocker: hold a palm out toward the door');
  await ramp(0.6, 0.97, 6);
  await caption('');
  await caught('knocker', 4);

  await look(SEAT, [0, 0.9, -1]);
  await page.evaluate(() => { const d = window.__holdStill.director; d.darkness.fadeTo(0, 3); d.text.show('You held still.', { mode: 'gaze', size: 0.08 }); });
  await caption('Survive five nights.');
  await sleep(5000);
} catch (e) {
  console.log('error', String(e?.stack || e));
} finally {
  const v = page.video();
  await t.close();
  console.log('video', v ? await v.path() : null);
}
