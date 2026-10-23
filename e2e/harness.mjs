// Shared Playwright harness for emulator tests: Chromium + IWER (injected by the
// Vite dev server on localhost) + a quiet fake microphone. See e2e/README.md.
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const here = path.dirname(new URL(import.meta.url).pathname);

export async function launch({ url = 'https://localhost:8195/?debug=1', outDir = path.join(here, 'out'), micRms = 0.003, video = null, viewport = { width: 640, height: 640 } } = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  const wav = path.join(outDir, `mic-${micRms}.wav`);
  if (!fs.existsSync(wav)) execFileSync('node', [path.join(here, 'make-wav.mjs'), wav, String(micRms), '60']);
  const exe = [process.env.CHROME_PATH, '/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].find((p) => p && fs.existsSync(p));
  const browser = await chromium.launch({
    executablePath: exe,
    headless: true,
    args: [
      '--ignore-certificate-errors', '--enable-webgl', '--use-gl=angle', '--use-angle=swiftshader',
      '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${wav}`,
      '--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding', '--no-sandbox',
    ],
  });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport, permissions: ['microphone'], ...(video ? { recordVideo: { dir: video, size: viewport } } : {}) });
  const page = await context.newPage();
  const logs = [];
  page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
  page.on('pageerror', (e) => logs.push(`[pageerror] ${e?.stack || e}`));
  await page.goto(url, { waitUntil: 'load', timeout: 90000 });
  await page.waitForFunction(() => !!window.IWER_DEVICE && !!window.__holdStill, null, { timeout: 90000 });
  await page.evaluate(() => {
    const d = window.IWER_DEVICE;
    d.controlMode = 'programmatic';
    if (d.devui?.devUIContainer) d.devui.devUIContainer.style.display = 'none';
  });
  const shot = async (name) => { const p = path.join(outDir, `${name}.png`); await page.screenshot({ path: p }); return p; };
  const state = () => page.evaluate(() => window.__holdStill.state());
  const close = async () => { fs.writeFileSync(path.join(outDir, 'console.log'), logs.join('\n')); await browser.close(); };
  return { browser, page, logs, shot, state, close, outDir };
}

/** Quaternion [x,y,z,w] from yaw (about +Y) then pitch (about +X), degrees. */
export function quat(yawDeg = 0, pitchDeg = 0) {
  const y = (yawDeg * Math.PI) / 360, p = (pitchDeg * Math.PI) / 360;
  const qy = [0, Math.sin(y), 0, Math.cos(y)], qp = [Math.sin(p), 0, 0, Math.cos(p)];
  const [ax, ay, az, aw] = qy, [bx, by, bz, bw] = qp;
  return [aw * bx + ax * bw + ay * bz - az * by, aw * by - ax * bz + ay * bw + az * bx, aw * bz + ax * by - ay * bx + az * bw, aw * bw - ax * bx - ay * by - az * bz];
}

/** Install in-page helpers on window.__e2e (pose the emulated head and hands). */
export async function installHelpers(page) {
  await page.evaluate(() => {
    const d = window.IWER_DEVICE;
    window.__e2e = {
      head(p, q) { d.position.set(...p); d.quaternion.set(...q); },
      hand(side, p, q, poseId) {
        const h = d.hands[side];
        h.position.set(...p); h.quaternion.set(...q);
        if (poseId) h.poseId = poseId;
      },
      pinch(side, v) { d.hands[side].updatePinchValue(v); },
      hands() { d.primaryInputMode = 'hand'; },
    };
  });
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll `fn` (async) until it returns truthy or time runs out. */
export async function until(fn, { timeoutMs = 60000, everyMs = 250, label = 'condition' } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await sleep(everyMs);
  }
}
