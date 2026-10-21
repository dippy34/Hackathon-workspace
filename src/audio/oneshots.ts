/**
 * The bank's one-shot sounds, one small function each (M2: replace any of
 * them with a recording played through Kit.sample). Signature:
 * (kit, out, startTime, gain) where gain already includes
 * CONFIG.audio.oneShotLevels[name] and the caller's gain.
 */

import type { OneShot } from '../game/contracts.js';
import { type Kit, pick, rand, SILENT } from './kit.js';
import { breath, creak, drag, squeak, throat } from './voices.js';

export type ShotFn = (k: Kit, out: AudioNode, t: number, g: number) => void;

// ─── Flow ─────────────────────────────────────────────────────────────

/** A wall switch, the tube flickering, the mains hum winding down, the room's air dropping away. */
function lightsOut(k: Kit, out: AudioNode, t: number, g: number): void {
  const b = k.b;
  k.sample(out, t, b.switchOn, 0.7 * g, { rate: 0.62 });
  k.sample(out, t + 0.004, pick(b.knocks), 0.12 * g, { rate: 2.6, lp: 3000 });

  const gr = k.group();
  const humEnv = gr.gain(0, out);
  const humLp = gr.filter('lowpass', 520, 1.2, humEnv);
  const hum = gr.osc('sawtooth', 58);
  hum.connect(humLp);
  const buzzEnv = gr.gain(0, out);
  const buzzBp = gr.filter('bandpass', 1800, 1.1, buzzEnv);
  const buzz = gr.osc('square', 116);
  buzz.connect(buzzBp);

  const h = 0.06 * g;
  const z = 0.03 * g;
  const at = [0, 0.03, 0.05, 0.09, 0.12, 0.2, 0.23];
  const lv = [1, 0.15, 0.9, 0.1, 0.7, 0.05, 0.5];
  for (let i = 0; i < at.length; i++) {
    humEnv.gain.setValueAtTime(h * lv[i], t + 0.01 + at[i]);
    buzzEnv.gain.setValueAtTime(z * lv[i], t + 0.01 + at[i]);
  }
  humEnv.gain.exponentialRampToValueAtTime(SILENT, t + 2.0);
  buzzEnv.gain.exponentialRampToValueAtTime(SILENT, t + 0.45);
  hum.frequency.setValueAtTime(58, t + 0.25);
  hum.frequency.exponentialRampToValueAtTime(38, t + 2.0);
  hum.start(t);
  hum.stop(t + 2.05);
  buzz.start(t);
  buzz.stop(t + 0.5);

  k.noise(out, t + 0.05, { buf: b.brown, gain: 0.2 * g, attack: 0.02, release: 1.2, type: 'lowpass', freq: 160, q: 0.5 });
}

/** Relief: a soft, warm open chord swelling and fading like light coming up, with a breath of air. */
function dawn(k: Kit, out: AudioNode, t: number, g: number): void {
  const gr = k.group();
  const env = gr.gain(0, out);
  const lp = gr.filter('lowpass', 600, 0.5, env);
  lp.frequency.setValueAtTime(600, t);
  lp.frequency.linearRampToValueAtTime(1800, t + 3);
  lp.frequency.linearRampToValueAtTime(900, t + 7.5);
  const notes = [146.83, 220, 293.66, 369.99, 440]; // D3 A3 D4 F#4 A4
  const amps = [0.5, 0.35, 0.3, 0.18, 0.12];
  for (let i = 0; i < notes.length; i++) {
    const o = gr.osc('triangle', notes[i], rand(-7, 7));
    o.connect(gr.gain(amps[i], lp));
    o.start(t);
    o.stop(t + 8);
  }
  const p = env.gain;
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(0.03 * g, t + 1);
  p.linearRampToValueAtTime(0.12 * g, t + 2.8);
  p.setValueAtTime(0.12 * g, t + 3.6);
  p.exponentialRampToValueAtTime(SILENT, t + 7.9);
  k.noise(out, t + 0.3, { buf: k.b.pink, gain: 0.05 * g, attack: 2.5, hold: 1, release: 3.5, type: 'bandpass', freq: 700, freqTo: 2200, q: 0.6 });
}

/** Calibration done: a tiny soft tick-tick. */
function calibrated(k: Kit, out: AudioNode, t: number, g: number): void {
  k.sample(out, t, k.b.tick, 0.5 * g);
  k.sample(out, t + 0.075, k.b.tick, 0.28 * g, { rate: 1.5 });
}

/** A window/door marker placed: one soft knuckle on wood. */
function placed(k: Kit, out: AudioNode, t: number, g: number): void {
  k.sample(out, t, k.b.knocks[0], 0.4 * g, { rate: 1.25, lp: 1500 });
}

// ─── Flashlight ───────────────────────────────────────────────────────

function flashOn(k: Kit, out: AudioNode, t: number, g: number): void {
  k.sample(out, t, k.b.switchOn, 0.6 * g);
}

function flashOff(k: Kit, out: AudioNode, t: number, g: number): void {
  k.sample(out, t, k.b.switchOff, 0.55 * g, { rate: 0.9 });
}

/** Battery gone: a dull dead click and a filament fizz that never catches. */
function flashEmpty(k: Kit, out: AudioNode, t: number, g: number): void {
  k.sample(out, t, k.b.switchOn, 0.5 * g, { rate: 0.7, lp: 900 });
  k.noise(out, t + 0.012, { gain: 0.03 * g, attack: 0.002, release: 0.07, type: 'bandpass', freq: 3200, q: 3 });
}

// ─── Retreats ─────────────────────────────────────────────────────────

/** Under the Desk gives up: a wet drag sliding away, a bump, a long exhale. */
function deskRetreat(k: Kit, out: AudioNode, t: number, g: number): void {
  drag(k, out, t, { dur: 1.7, gain: 0.5 * g, freq: 1100, freqTo: 320, q: 1.1, rate: 0.55, attack: 0.04, lp: 2600 });
  drag(k, out, t + 0.05, { dur: 1.4, gain: 0.35 * g, freq: 380, freqTo: 180, q: 2.5, rate: 0.35 });
  k.sample(out, t + rand(0.35, 0.6), pick(k.b.knocks), 0.22 * g, { rate: 1.4, lp: 1200 });
  breath(k, out, t + 0.6, { dur: 1.8, gain: 0.16 * g, freq: 1000, freqTo: 520 });
}

/** The Peeker withdraws: a squeak sliding down the glass, then two fading taps. */
function glassRetreat(k: Kit, out: AudioNode, t: number, g: number): void {
  squeak(k, out, t, { dur: 0.75, gain: 0.12 * g, freq: rand(1900, 2300), toMul: 0.5 });
  k.sample(out, t + 0.95, pick(k.b.taps), 0.22 * g, { lp: 4000 });
  k.sample(out, t + 1.75, pick(k.b.taps), 0.08 * g, { lp: 2500, rate: 0.95 });
}

/** The Knocker relents: a slow creak closing, the door meeting the frame, the latch. */
function doorRetreat(k: Kit, out: AudioNode, t: number, g: number): void {
  creak(k, out, t, { dur: 1.6, gain: 0.6 * g, pitch: 0.85, closing: true });
  k.sample(out, t + 1.6, pick(k.b.knocks), 0.25 * g, { rate: 0.8, lp: 900 });
  k.sample(out, t + 1.62, k.b.latch, 0.7 * g);
}

/** The Listener leaves: a soft breath out (the ringing release and room tone return happen elsewhere). */
function listenerLeave(k: Kit, out: AudioNode, t: number, g: number): void {
  breath(k, out, t, { dur: 2.2, gain: 0.14 * g, freq: 820, freqTo: 420 });
  k.noise(out, t + 0.2, { buf: k.b.pink, gain: 0.025 * g, attack: 1.2, release: 1.5, type: 'lowpass', freq: 900, q: 0.5 });
}

// ─── Caught moments ───────────────────────────────────────────────────

/** Under the Desk: a scraping lunge, a violent thud, things jumping, a wet snarl, dragged down. */
function grab(k: Kit, out: AudioNode, t: number, g: number): void {
  const b = k.b;
  drag(k, out, t, { dur: 0.3, gain: 0.75 * g, freq: 1200, freqTo: 3800, q: 1, rate: 1.6, attack: 0.03 });
  k.noise(out, t, { gain: 0.3 * g, attack: 0.18, release: 0.08, type: 'bandpass', freq: 400, freqTo: 1600, q: 0.9 });
  const hit = t + 0.24;
  k.sample(out, hit, pick(b.knocks), 1.0 * g, { rate: 0.55, lp: 2500 });
  k.tone(out, hit, { freq: 85, freqTo: 38, glide: 0.35, gain: 0.9 * g, attack: 0.003, release: 0.5 });
  k.noise(out, hit, { buf: b.brown, gain: 0.8 * g, attack: 0.002, release: 0.35, type: 'lowpass', freq: 420, q: 0.7 });
  k.noise(out, hit, { gain: 0.5 * g, attack: 0.001, release: 0.05, type: 'highpass', freq: 2500 });
  k.sample(out, hit + 0.06, pick(b.clicks), 0.3 * g, { rate: 0.8 });
  k.sample(out, hit + 0.11, pick(b.knocks), 0.25 * g, { rate: 2.1, lp: 3000 });
  drag(k, out, hit + 0.05, { dur: 0.7, gain: 0.5 * g, freq: 900, freqTo: 400, q: 1.4, rate: 0.8 });
  throat(k, out, hit - 0.05, {
    dur: 0.6,
    gain: 0.35 * g,
    f0: 72,
    startMul: 0.9,
    endMul: 0.8,
    bendSec: 0.1,
    formants: [
      [420, 3, 1],
      [900, 4, 0.6],
      [2300, 6, 0.3],
    ],
    spread: 40,
    wobbleHz: 23,
    wobbleCents: 80,
    drive: 2.5,
    rasp: 0.5,
    raspHz: 1200,
  });
}

/** The Listener's catch: a harsh, loud, close scream (~1.2 s) with a burst of breath. */
function scream(k: Kit, out: AudioNode, t: number, g: number): void {
  k.noise(out, t, { gain: 0.6 * g, attack: 0.002, release: 0.25, type: 'bandpass', freq: 3200, freqTo: 1500, q: 0.8 });
  throat(k, out, t, {
    dur: 1.25,
    gain: 0.85 * g,
    f0: rand(420, 500),
    startMul: 0.62,
    endMul: 0.78,
    bendSec: 0.09,
    formants: [
      [900, 5, 1],
      [1300, 6, 0.8],
      [2700, 8, 0.65],
      [3500, 9, 0.4],
    ],
    spread: 30,
    wobbleHz: rand(9, 12),
    wobbleCents: 55,
    drive: 1.6,
    rasp: 0.45,
    raspHz: 2800,
    sub: 0.35,
  });
}

/** The Peeker's catch: air rushing at your face, then a shriek on arrival. */
function faceRush(k: Kit, out: AudioNode, t: number, g: number): void {
  const b = k.b;
  k.noise(out, t, { buf: b.pink, gain: 0.6 * g, attack: 0.5, release: 0.25, type: 'bandpass', freq: 280, freqTo: 3800, q: 1.4 });
  k.noise(out, t + 0.1, { buf: b.brown, gain: 0.5 * g, attack: 0.4, release: 0.3, type: 'lowpass', freq: 220, q: 0.7 });
  const hit = t + 0.42;
  k.noise(out, hit, { gain: 0.5 * g, attack: 0.002, release: 0.12, type: 'highpass', freq: 1800 });
  throat(k, out, hit, {
    dur: 0.75,
    gain: 0.7 * g,
    f0: rand(1100, 1300),
    startMul: 0.7,
    endMul: 1.25,
    bendSec: 0.12,
    formants: [
      [2200, 4, 1],
      [3600, 6, 0.7],
      [1400, 5, 0.5],
    ],
    spread: 45,
    wobbleHz: 14,
    wobbleCents: 70,
    drive: 1.4,
    rasp: 0.5,
    raspHz: 4200,
  });
}

/** The Knocker's catch: the door slams open — burst, boom, splintering wood, the wall, a roar. */
function doorBurst(k: Kit, out: AudioNode, t: number, g: number): void {
  const b = k.b;
  k.noise(out, t, { gain: 0.95 * g, attack: 0.002, release: 0.45, type: 'lowpass', freq: 5000, freqTo: 900, q: 0.6 });
  k.sample(out, t, pick(b.knocks), 1.0 * g, { rate: 0.45 });
  k.tone(out, t, { freq: 62, freqTo: 30, glide: 0.6, gain: 0.95 * g, attack: 0.003, release: 0.8 });
  k.noise(out, t, { gain: 0.8 * g, attack: 0.001, release: 0.07, type: 'highpass', freq: 2200 });
  for (let i = 0; i < 7; i++) {
    k.sample(out, t + rand(0.01, 0.28), pick(b.knocks), rand(0.08, 0.22) * g, { rate: rand(2.4, 3.6), hp: 900 });
  }
  k.sample(out, t + 0.01, b.latch, 0.6 * g, { rate: 0.8 });
  k.sample(out, t + 0.19, pick(b.knocks), 0.7 * g, { rate: 0.6, lp: 1600 });
  throat(k, out, t + 0.1, {
    dur: 1.35,
    gain: 0.7 * g,
    f0: rand(95, 110),
    startMul: 0.8,
    endMul: 0.7,
    bendSec: 0.2,
    formants: [
      [500, 4, 1],
      [900, 5, 0.8],
      [2400, 7, 0.45],
    ],
    spread: 35,
    wobbleHz: 17,
    wobbleCents: 60,
    drive: 2.2,
    rasp: 0.55,
    raspHz: 1500,
    sub: 0.6,
  });
}

export const ONE_SHOTS: Readonly<Record<OneShot, ShotFn>> = {
  lightsOut,
  dawn,
  calibrated,
  placed,
  flashOn,
  flashOff,
  flashEmpty,
  deskRetreat,
  glassRetreat,
  doorRetreat,
  listenerLeave,
  grab,
  scream,
  faceRush,
  doorBurst,
};
