/**
 * Multi-node sound events shared by loops and one-shots: hinge creak, glass
 * squeak, grit drag, breath and a formant "throat" (screams, shrieks, the
 * roar). Each books one self-cleaning Group at time `t`.
 */

import { envelope, type Group, type Kit, rand, SILENT, type SourceSet } from './kit.js';

/** Optional pan + lowpass in front of `dest`. */
function outFor(g: Group, dest: AudioNode, pan?: number, lp?: number): AudioNode {
  let out: AudioNode = pan !== undefined ? g.pan(pan, dest) : dest;
  if (lp) out = g.filter('lowpass', lp, 0.7, out);
  return out;
}

// ─── Hinge creak ──────────────────────────────────────────────────────

export interface CreakOpts {
  dur: number;
  gain: number;
  /** Pitch multiplier (lower = bigger, slower door). */
  pitch?: number;
  /** Pitch sags at the end (door swinging shut). */
  closing?: boolean;
  /** Extra lowpass (Hz) for distant creaks. */
  lp?: number;
  pan?: number;
}

/**
 * A slow hinge creak: a sawtooth whose pitch wavers slowly through three
 * narrow resonances (hinge + door panel, harmonics land at 300-1600 Hz),
 * with stick-slip amplitude jitter (the shared jitter buffer drives the gain).
 */
export function creak(k: Kit, dest: AudioNode, t: number, o: CreakOpts, owner: SourceSet | null = null): void {
  if (o.gain <= SILENT) return;
  const g = k.group(owner);
  const p = o.pitch ?? 1;
  const dur = Math.max(0.2, o.dur);
  const end = t + dur;

  const env = g.gain(0, outFor(g, dest, o.pan, o.lp));
  const am = g.gain(0, env); // gain = jitter signal (0..1)
  const osc = g.osc('sawtooth', 200);
  const lo = g.filter('bandpass', rand(320, 420) * p, 5, am);
  const mid = g.filter('bandpass', rand(520, 780) * p, 7, am);
  const hi = g.filter('bandpass', rand(1150, 1600) * p, 10, am);
  osc.connect(lo);
  osc.connect(mid);
  osc.connect(hi);

  // Slowly wavering stick-slip pitch.
  const f = osc.frequency;
  const base = rand(150, 260) * p;
  f.setValueAtTime(base, t);
  const segs = 3 + ((Math.random() * 3) | 0);
  for (let i = 1; i <= segs; i++) {
    const m = i === segs && o.closing ? rand(0.55, 0.7) : rand(0.72, 1.45);
    f.linearRampToValueAtTime(base * m, t + (dur * i) / segs);
  }

  const jit = g.buffer(k.b.jitter, true, rand(0.6, 1.4));
  jit.connect(am.gain);

  const a = Math.min(0.35, dur * 0.18);
  const r = Math.min(0.6, dur * 0.3);
  envelope(env.gain, t, o.gain, a, Math.max(0, dur - a - r), r);
  osc.start(t);
  osc.stop(end + 0.05);
  jit.start(t, Math.random() * k.b.jitter.duration * 0.9);
  jit.stop(end + 0.05);
}

// ─── Glass squeak ─────────────────────────────────────────────────────

export interface SqueakOpts {
  dur: number;
  gain: number;
  /** Start pitch (Hz), default 1300-2200. */
  freq?: number;
  /** End pitch multiplier (default wanders ±20%). */
  toMul?: number;
  lp?: number;
}

/** A fingertip dragging on wet glass: stuttering high tone with stick-slip AM. */
export function squeak(k: Kit, dest: AudioNode, t: number, o: SqueakOpts, owner: SourceSet | null = null): void {
  if (o.gain <= SILENT) return;
  const g = k.group(owner);
  const dur = Math.max(0.1, o.dur);
  const env = g.gain(0, outFor(g, dest, undefined, o.lp));
  const am = g.gain(0, env);
  const bp = g.filter('bandpass', 2400, 2.5, am);
  const osc = g.osc('sawtooth', 1600);
  osc.connect(bp);
  const f0 = o.freq ?? rand(1300, 2200);
  const f1 = f0 * (o.toMul ?? rand(0.8, 1.2));
  osc.frequency.setValueAtTime(f0, t);
  osc.frequency.linearRampToValueAtTime((f0 + f1) * 0.5 * rand(0.92, 1.08), t + dur * 0.5);
  osc.frequency.linearRampToValueAtTime(f1, t + dur);
  bp.frequency.setValueAtTime(f0 * 1.5, t);
  bp.frequency.linearRampToValueAtTime(f1 * 1.5, t + dur);
  const jit = g.buffer(k.b.jitter, true, rand(1.8, 3.2)); // faster stick-slip than a hinge
  jit.connect(am.gain);
  envelope(env.gain, t, o.gain, Math.min(0.06, dur * 0.2), dur * 0.5, dur * 0.3);
  osc.start(t);
  osc.stop(t + dur + 0.05);
  jit.start(t, Math.random() * k.b.jitter.duration * 0.9);
  jit.stop(t + dur + 0.05);
}

// ─── Grit drag (nails, claws, a body sliding) ─────────────────────────

export interface DragOpts {
  dur: number;
  gain: number;
  /** Bandpass centre at start / end (Hz). */
  freq: number;
  freqTo: number;
  q?: number;
  /** Grit playback rate: low = slow, wet, clicky; high = fast, harsh. */
  rate?: number;
  attack?: number;
  lp?: number;
  pan?: number;
}

export function drag(k: Kit, dest: AudioNode, t: number, o: DragOpts, owner: SourceSet | null = null): void {
  if (o.gain <= SILENT) return;
  const g = k.group(owner);
  const dur = Math.max(0.05, o.dur);
  const env = g.gain(0, outFor(g, dest, o.pan, o.lp));
  const bp = g.filter('bandpass', o.freq, o.q ?? 1.2, env);
  bp.frequency.setValueAtTime(o.freq, t);
  bp.frequency.exponentialRampToValueAtTime(Math.max(40, o.freqTo), t + dur);
  const s = g.buffer(k.b.grit, true, o.rate ?? 1);
  s.connect(bp);
  const a = o.attack ?? Math.min(0.05, dur * 0.15);
  envelope(env.gain, t, o.gain, a, dur * 0.45, Math.max(0.02, dur * 0.55 - a));
  s.start(t, Math.random() * k.b.grit.duration * 0.9);
  s.stop(t + dur + 0.05);
}

// ─── Breath ───────────────────────────────────────────────────────────

export interface BreathOpts {
  dur: number;
  gain: number;
  /** Bandpass centre start / end (Hz) — falling = exhale. */
  freq?: number;
  freqTo?: number;
  pan?: number;
}

/** A slow, close breath (pink noise through a moving vowel-ish band). */
export function breath(k: Kit, dest: AudioNode, t: number, o: BreathOpts, owner: SourceSet | null = null): void {
  if (o.gain <= SILENT) return;
  const dur = Math.max(0.2, o.dur);
  k.noise(
    dest,
    t,
    {
      buf: k.b.pink,
      gain: o.gain,
      attack: dur * 0.3,
      hold: dur * 0.15,
      release: dur * 0.55,
      type: 'bandpass',
      freq: o.freq ?? 1100,
      freqTo: o.freqTo ?? 600,
      q: 0.8,
      pan: o.pan,
    },
    owner,
  );
}

// ─── Throat: screams, shrieks, the roar ───────────────────────────────

export interface ThroatOpts {
  dur: number;
  gain: number;
  /** Fundamental (Hz) at the peak of the cry. */
  f0: number;
  /** Pitch at onset / end, as multiples of f0. */
  startMul: number;
  endMul: number;
  /** Seconds to bend from onset pitch up to f0. */
  bendSec: number;
  /** Formant bands: [Hz, Q, gain]. */
  formants: readonly (readonly [number, number, number])[];
  /** Detune spread (cents) of the three voices. */
  spread?: number;
  /** Vibrato / roughness rate (Hz) and depth (cents). */
  wobbleHz?: number;
  wobbleCents?: number;
  /** Pre-drive into the soft clipper (higher = harsher). */
  drive?: number;
  /** Noise rasp level (relative) and band (Hz). */
  rasp?: number;
  raspHz?: number;
  /** Add a voice an octave down (relative gain). */
  sub?: number;
}

/**
 * Layered detuned saws -> soft clipper -> parallel formant bandpasses, with
 * a pitch bend, wobble and a noise rasp. Harsh, close and loud; ~20 nodes, so
 * only for one-shots.
 */
export function throat(k: Kit, dest: AudioNode, t: number, o: ThroatOpts): void {
  if (o.gain <= SILENT) return;
  const g = k.group(null);
  const dur = Math.max(0.2, o.dur);
  const end = t + dur;

  const env = g.gain(0, dest);
  const fmix = g.gain(1, env);
  const sum = g.gain(o.drive ?? 0.6);
  const clip = g.shaper();
  sum.connect(clip);
  for (const [hz, q, a] of o.formants) {
    const bp = g.filter('bandpass', hz, q);
    const ga = g.gain(a, fmix);
    clip.connect(bp);
    bp.connect(ga);
  }

  const wob = g.osc('sine', o.wobbleHz ?? 9);
  const wobDepth = g.gain(o.wobbleCents ?? 45);
  wob.connect(wobDepth);

  const spread = o.spread ?? 28;
  const voices = o.sub ? 4 : 3;
  for (let i = 0; i < voices; i++) {
    const isSub = i === 3;
    const base = isSub ? o.f0 * 0.5 : o.f0;
    const osc = g.osc('sawtooth', base * o.startMul, isSub ? 0 : (i - 1) * spread + rand(-6, 6));
    const f = osc.frequency;
    f.setValueAtTime(base * o.startMul, t);
    f.exponentialRampToValueAtTime(base, t + Math.max(0.02, o.bendSec));
    f.linearRampToValueAtTime(base * (1 + (o.endMul - 1) * 0.3), t + dur * 0.6);
    f.linearRampToValueAtTime(base * o.endMul, end);
    wobDepth.connect(osc.detune);
    if (isSub) {
      const sg = g.gain(o.sub ?? 0.5, sum);
      osc.connect(sg);
    } else {
      osc.connect(sum);
    }
    osc.start(t);
    osc.stop(end + 0.05);
  }
  wob.start(t);
  wob.stop(end + 0.05);

  // Ragged loudness: slam in, a catch of breath, a long tearing tail.
  const p = env.gain;
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(o.gain, t + 0.012);
  p.linearRampToValueAtTime(o.gain * 0.72, t + Math.min(0.18, dur * 0.15));
  p.linearRampToValueAtTime(o.gain * 0.95, t + dur * 0.3);
  p.linearRampToValueAtTime(o.gain * 0.8, t + dur * 0.7);
  p.exponentialRampToValueAtTime(SILENT, end);

  if (o.rasp) {
    k.noise(dest, t, {
      gain: o.gain * o.rasp,
      attack: 0.01,
      hold: dur * 0.45,
      release: dur * 0.5,
      type: 'bandpass',
      freq: o.raspHz ?? 2600,
      freqTo: (o.raspHz ?? 2600) * 0.7,
      q: 0.9,
    });
  }
}
