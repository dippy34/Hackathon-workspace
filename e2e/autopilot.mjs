// In-page "ideal player" for the emulator: reads the director's live state and
// poses the emulated hands to counter every active threat, the way a competent
// human would (desk first; flashlight with the right hand; palm-out with the left).
// `ignore` lists threats the autopilot deliberately does NOT counter.
export async function installAutopilot(page) {
  await page.evaluate(() => {
    const d = window.IWER_DEVICE;
    const hs = window.__holdStill;
    const dir = hs.director;
    const DESK_Y = 0.75;
    const qFromYawPitch = (yaw, pitch) => {
      const y = yaw / 2, p = pitch / 2;
      const [ax, ay, az, aw] = [0, Math.sin(y), 0, Math.cos(y)], [bx, by, bz, bw] = [Math.sin(p), 0, 0, Math.cos(p)];
      return [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz];
    };
    const flatQ = qFromYawPitch(0, (-30 * Math.PI) / 180);
    const set = (side, p, q, pinch) => {
      const h = d.hands[side];
      h.position.set(p[0], p[1], p[2]);
      h.quaternion.set(q[0], q[1], q[2], q[3]);
      h.updatePinchValue(pinch);
    };
    const aimAt = (from, to) => {
      const dx = to.x - from[0], dy = to.y - from[1], dz = to.z - from[2];
      return qFromYawPitch(Math.atan2(-dx, -dz), Math.atan2(dy, Math.hypot(dx, dz)));
    };
    const palmAt = (from, to) => {
      const dx = to.x - from[0], dz = to.z - from[2];
      // pitch 60 deg turns the palm to face -Z; yaw then turns it toward the target.
      return qFromYawPitch(Math.atan2(-dx, -dz), (60 * Math.PI) / 180);
    };
    const ap = (window.__autopilot = { ignore: [], enabled: true, ticks: 0, decisions: {} });
    setInterval(() => {
      if (!ap.enabled || !d.activeSession) return;
      ap.ticks++;
      const runner = dir.flow.runner;
      const active = dir.flow.phase === 'night' && runner ? runner.activeAttacks().map((a) => a.id) : [];
      const want = (id) => active.includes(id) && !ap.ignore.includes(id);
      const L = [-0.18, DESK_Y, -0.4], R = [0.18, DESK_Y, -0.4];
      let left = [L, flatQ, 0], right = [R, flatQ, 0];
      if (ap.ignore.includes('underDesk') && active.length === 0) {
        // A player who ignores the desk keeps their hands in their lap... off the desk.
        left = [[-0.18, DESK_Y + 0.3, -0.3], flatQ, 0]; right = [[0.18, DESK_Y + 0.3, -0.3], flatQ, 0];
      }
      let decision = 'rest';
      if (want('underDesk')) {
        decision = 'desk';
      } else {
        if (ap.ignore.includes('underDesk')) {
          left = [[-0.18, DESK_Y + 0.3, -0.3], flatQ, 0]; right = [[0.18, DESK_Y + 0.3, -0.3], flatQ, 0];
        }
        if (want('peeker')) {
          const p = [0.2, 1.0, -0.3];
          right = [p, aimAt(p, dir.threats.peeker.facePos), 1];
          decision = 'light';
        }
        if (want('knocker')) {
          const p = [-0.2, DESK_Y + 0.3, -0.3];
          left = [p, palmAt(p, dir.threats.knocker.doorTarget), 0];
          decision += '+palm';
        }
      }
      ap.decisions[decision] = (ap.decisions[decision] ?? 0) + 1;
      set('left', ...left);
      set('right', ...right);
    }, 40);
  });
}

/** Make the fake mic "loud" (for Listener catch tests): overrides mic.noisy. */
export async function setNoisy(page, noisy) {
  await page.evaluate((noisy) => {
    const mic = window.__holdStill.director.mic;
    Object.defineProperty(mic, 'noisy', { configurable: true, get: () => noisy });
  }, noisy);
}
