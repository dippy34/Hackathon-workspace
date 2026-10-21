// Renders each monster for review: in the night darkness, at low and full danger,
// from the seated player's view and close up, plus frames of its caught moment.
// Usage: (dev server on 8195) node e2e/showcase.mjs  -> e2e/out/show-*.png
import { launch, quat, until, sleep } from './harness.mjs';
import { enterAndCalibrate } from './flow.mjs';

const t = await launch({ url: process.argv[2] });
const { page, shot } = t;
const SEAT = [0, 1.2, 0];
const shots = [];

const aim = (from, to) => {
  const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2];
  return quat((Math.atan2(-dx, -dz) * 180) / Math.PI, (Math.atan2(dy, Math.hypot(dx, dz)) * 180) / Math.PI);
};
const look = async (from, to) => page.evaluate(([p, q]) => __e2e.head(p, q), [from, aim(from, to)]);
const toward = (target, dist, from = SEAT) => {
  const d = target.map((v, i) => from[i] - v), n = Math.hypot(...d) || 1;
  return target.map((v, i) => v + (d[i] / n) * dist);
};
const snap = async (name) => { shots.push(await shot(`show-${name}`)); };

try {
  await enterAndCalibrate(t);
  // Freeze the game: no flow, no autopilot, no overlay or room markers. Night darkness on.
  await page.evaluate(() => {
    const d = window.__holdStill.director;
    window.__autopilot.enabled = false;
    d.flow.update = () => {};
    d.overlay.setVisible(false);
    d.room.setMarkersVisible(false);
    d.text.hide(0);
    d.darkness.fadeTo(0.94, 0.01);
  });
  // Hands resting on the desk for context.
  await page.evaluate((q) => { __e2e.hand('left', [-0.18, 0.75, -0.4], q, 'default'); __e2e.hand('right', [0.18, 0.75, -0.4], q, 'default'); }, quat(0, -30));

  for (const id of ['underDesk', 'peeker', 'knocker']) {
    // Start an attack by hand and keep feeding it a meter value.
    const target = await page.evaluate((id) => {
      const d = window.__holdStill.director, P = d.threats[id];
      P.reset();
      const attack = { id, meter: 0.35, countering: false, teaching: false, ageSec: 3, counteredSec: 0, remainingLeaveSec: 5, state: 'active' };
      P.begin(attack, d.ctx);
      clearInterval(window.__showTimer);
      window.__showAttack = attack;
      window.__showTimer = setInterval(() => { attack.ageSec += 0.03; P.update(attack, d.ctx); }, 30);
      const v = id === 'peeker' ? P.facePos : id === 'knocker' ? P.doorTarget : P.root.getWorldPosition(P.root.position.clone());
      return [v.x, v.y, v.z];
    }, id);
    const seatTarget = id === 'underDesk' ? [target[0], 0.72, target[2] + 0.2] : target;
    await look(SEAT, seatTarget);
    await sleep(6000);
    await snap(`${id}-1-low-danger`);
    await page.evaluate(() => (window.__showAttack.meter = 0.97));
    await sleep(6000);
    await snap(`${id}-2-full-danger`);
    // Close-up (for Under the Desk: crouch to see under the desk).
    const close = id === 'underDesk' ? [target[0], target[1] + 0.05, target[2] + 0.75] : toward(target, 0.9);
    await look(close, target);
    await sleep(2500);
    await snap(`${id}-3-closeup`);
    // Caught moment, seen from the seat.
    await look(SEAT, seatTarget);
    await sleep(1500);
    await page.evaluate((id) => { clearInterval(window.__showTimer); const d = window.__holdStill.director; d.threats[id].caught(d.ctx); }, id);
    for (let i = 1; i <= 5; i++) { await sleep(220); await snap(`${id}-4-caught-${i}`); }
    await page.evaluate((id) => window.__holdStill.director.threats[id].reset(), id);
    await sleep(500);
  }
  console.log(JSON.stringify({ ok: true, shots }, null, 2));
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: String(e?.stack || e), shots }, null, 2));
} finally {
  const errors = t.logs.filter((l) => l.startsWith('[error]') || l.startsWith('[pageerror]'));
  if (errors.length) console.log(errors.slice(0, 10).join('\n'));
  await t.close();
}
