/**
 * Procedurally rendered sample data for the sound bank, made ONCE per
 * AudioContext (≈30 ms of JS at start-up):
 *
 * - loopable noise beds: white, pink, brown (brown at a low sample rate, it
 *   only ever plays lowpassed);
 * - textures: `grit` (fingernail stick-slip grains) and `jitter` (a 0..1
 *   control signal that drives stick-slip amplitude on creaks and squeaks);
 * - short pre-rendered transients: glass taps, wood knocks, metal clicks,
 *   a latch, switch clicks, heartbeat thumps, a soft tick.
 *
 * Pre-rendering transients means each hit costs 2-3 Web Audio nodes instead
 * of 6-10, which keeps the Quest's audio thread light.
 *
 * M2: any of these can be swapped for a decoded recording with the same role
 * (the bank only cares that it is an AudioBuffer).
 */

type Rng = () => number;

/** Seeded so the bank sounds the same every session (variation is added at play time). */
function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SoundBuffers {
  /** 1.5 s white noise, loopable. */
  readonly white: AudioBuffer;
  /** 3 s pink noise, loopable. */
  readonly pink: AudioBuffer;
  /** 8 s brown noise at 8 kHz, loopable (room tone, thuds, rumble). */
  readonly brown: AudioBuffer;
  /** 1.6 s fingernail stick-slip grain texture, loopable. Play through a bandpass. */
  readonly grit: AudioBuffer;
  /** 2 s, 0..1 stick-slip control signal at 8 kHz, loopable. Connect to a gain AudioParam. */
  readonly jitter: AudioBuffer;
  /** Fingernail on window glass (variants). */
  readonly taps: readonly AudioBuffer[];
  /** Knuckles on a wooden door (variants). */
  readonly knocks: readonly AudioBuffer[];
  /** Small metal clicks: door-handle rattle, pipe ticks (variants). */
  readonly clicks: readonly AudioBuffer[];
  /** Door latch / bolt seating. */
  readonly latch: AudioBuffer;
  /** Plastic switch click, press (strong first) and release (strong second). */
  readonly switchOn: AudioBuffer;
  readonly switchOff: AudioBuffer;
  /** Heartbeat "lub" and "dub". */
  readonly lub: AudioBuffer;
  readonly dub: AudioBuffer;
  /** Small soft wooden tick (UI confirmation). */
  readonly tick: AudioBuffer;
}

// ─── Low-level helpers (init-time only; allocation here is fine) ─────────

function toBuffer(ctx: BaseAudioContext, data: Float32Array, sampleRate: number): AudioBuffer {
  const buf = ctx.createBuffer(1, data.length, sampleRate);
  buf.getChannelData(0).set(data);
  return buf;
}

function normalize(d: Float32Array, peak: number): Float32Array {
  let m = 0;
  for (let i = 0; i < d.length; i++) {
    const v = Math.abs(d[i]);
    if (v > m) m = v;
  }
  if (m > 0) {
    const s = peak / m;
    for (let i = 0; i < d.length; i++) d[i] *= s;
  }
  return d;
}

/**
 * Render `len + fade` samples with `fill`, then fold the overhang onto the
 * start with an equal-power crossfade so the buffer loops without a click:
 * sample len-1 is followed (on wrap) by what was originally sample `len`.
 */
function seamless(len: number, fade: number, fill: (d: Float32Array) => void): Float32Array {
  const tmp = new Float32Array(len + fade);
  fill(tmp);
  for (let i = 0; i < fade; i++) {
    const w = (i / fade) * (Math.PI / 2);
    tmp[i] = tmp[i] * Math.sin(w) + tmp[len + i] * Math.cos(w);
  }
  return tmp.slice(0, len);
}

interface Partial {
  f: number;
  a: number;
  /** Exponential decay time constant (s). */
  tau: number;
}

/** Add exponentially decaying sines (sine recurrence, no per-sample sin()). */
function addPartials(d: Float32Array, sr: number, start: number, partials: readonly Partial[], rng: Rng): void {
  for (const p of partials) {
    if (p.f <= 0 || p.f >= sr / 2) continue;
    const w = (2 * Math.PI * p.f) / sr;
    const k = Math.exp(-1 / (p.tau * sr));
    const c = 2 * Math.cos(w);
    const ph = rng() * 2 * Math.PI;
    let s1 = Math.sin(ph - w);
    let s2 = Math.sin(ph - 2 * w);
    let e = p.a;
    for (let i = start; i < d.length && e > 1e-5; i++) {
      const s0 = c * s1 - s2;
      s2 = s1;
      s1 = s0;
      d[i] += s0 * e;
      e *= k;
    }
  }
}

/** Bright click: differentiated white noise with a very fast decay. */
function addClick(d: Float32Array, sr: number, start: number, amp: number, tau: number, rng: Rng): void {
  const k = Math.exp(-1 / (tau * sr));
  let e = amp;
  let prev = 0;
  for (let i = start; i < d.length && e > 1e-5; i++) {
    const w = rng() * 2 - 1;
    d[i] += (w - prev) * 0.5 * e;
    prev = w;
    e *= k;
  }
}

/** Sine whose pitch glides f0 -> f1 (exp, time constant glideTau) with attack + exp decay. */
function addThump(
  d: Float32Array,
  sr: number,
  start: number,
  f0: number,
  f1: number,
  glideTau: number,
  amp: number,
  decayTau: number,
  attackTau: number,
): void {
  // Exponentials as per-sample multipliers (only one sin() per sample).
  const kg = Math.exp(-1 / (glideTau * sr));
  const ka = Math.exp(-1 / (attackTau * sr));
  const kd = Math.exp(-1 / (decayTau * sr));
  const w = (2 * Math.PI) / sr;
  let glide = 1;
  let att = 1;
  let env = amp;
  let ph = 0;
  const end = Math.min(d.length, start + Math.ceil(decayTau * 9 * sr));
  for (let i = start; i < end; i++) {
    ph += w * (f1 + (f0 - f1) * glide);
    d[i] += Math.sin(ph) * env * (1 - att);
    glide *= kg;
    att *= ka;
    env *= kd;
  }
}

/** Two-pole resonator: rings `src` at `f` (unit gain at resonance, roughly) into `d`. */
function addResonator(src: Float32Array, d: Float32Array, sr: number, f: number, tau: number, gain: number): void {
  const w = (2 * Math.PI * f) / sr;
  const r = Math.exp(-1 / (tau * sr));
  const c = 2 * r * Math.cos(w);
  const r2 = r * r;
  const norm = (1 - r) * 2 * Math.sin(w) * gain;
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < src.length; i++) {
    const y = src[i] + c * y1 - r2 * y2;
    y2 = y1;
    y1 = y;
    d[i] += y * norm;
  }
}

function fadeIn(d: Float32Array, samples: number): void {
  const n = Math.min(d.length, Math.max(1, samples | 0));
  for (let i = 0; i < n; i++) d[i] *= i / n;
}

function fadeOutTail(d: Float32Array, samples: number): void {
  const n = Math.min(d.length, Math.max(1, samples | 0));
  for (let i = 0; i < n; i++) d[d.length - 1 - i] *= i / n;
}

// ─── Noise beds + textures ─────────────────────────────────────────────

function renderWhite(ctx: BaseAudioContext, rng: Rng): AudioBuffer {
  const sr = ctx.sampleRate;
  const d = new Float32Array(Math.round(1.5 * sr));
  for (let i = 0; i < d.length; i++) d[i] = rng() * 2 - 1;
  return toBuffer(ctx, normalize(d, 0.95), sr);
}

function renderPink(ctx: BaseAudioContext, rng: Rng): AudioBuffer {
  const sr = ctx.sampleRate;
  const len = Math.round(3 * sr);
  const d = seamless(len, Math.round(0.05 * sr), (o) => {
    // Paul Kellet's refined pink filter, warmed up first.
    let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
    for (let i = -2048; i < o.length; i++) {
      const w = rng() * 2 - 1;
      b0 = 0.99886 * b0 + w * 0.0555179;
      b1 = 0.99332 * b1 + w * 0.0750759;
      b2 = 0.969 * b2 + w * 0.153852;
      b3 = 0.8665 * b3 + w * 0.3104856;
      b4 = 0.55 * b4 + w * 0.5329522;
      b5 = -0.7616 * b5 - w * 0.016898;
      const p = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
      b6 = w * 0.115926;
      if (i >= 0) o[i] = p;
    }
  });
  return toBuffer(ctx, normalize(d, 0.95), sr);
}

const LOW_SR = 8000;

function renderBrown(ctx: BaseAudioContext, rng: Rng): AudioBuffer {
  const len = 8 * LOW_SR;
  const d = seamless(len, Math.round(0.25 * LOW_SR), (o) => {
    let last = 0;
    for (let i = -2000; i < o.length; i++) {
      const w = rng() * 2 - 1;
      last = (last + 0.02 * w) / 1.02;
      if (i >= 0) o[i] = last * 3.5;
    }
  });
  return toBuffer(ctx, normalize(d, 0.95), LOW_SR);
}

/** Stick-slip grains: a fingernail catching and releasing on wood grain. */
function renderGrit(ctx: BaseAudioContext, rng: Rng): AudioBuffer {
  const sr = ctx.sampleRate;
  const len = Math.round(1.6 * sr);
  const d = seamless(len, Math.round(0.03 * sr), (o) => {
    const n = o.length;
    let pos = 0;
    while (pos < n) {
      const big = rng() < 0.07;
      const amp = big ? 0.9 + rng() * 0.6 : 0.12 + rng() * 0.55;
      const glen = Math.max(8, ((0.0006 + rng() * 0.0035) * sr) | 0);
      const k = Math.exp(-4 / glen);
      let e = amp;
      for (let j = 0; j < glen && pos + j < n; j++) {
        o[pos + j] += (rng() * 2 - 1) * e;
        e *= k;
      }
      // 3-27 ms between catches, skewed short (40-330 Hz catch rate).
      pos += Math.max(1, ((0.003 + rng() * rng() * 0.024) * sr) | 0);
    }
    // The smooth drag between catches.
    for (let i = 0; i < n; i++) o[i] += (rng() * 2 - 1) * 0.05;
  });
  return toBuffer(ctx, normalize(d, 0.95), sr);
}

/** 0..1 control: holds 4-34 ms, sometimes slipping to ~0 (the "catch" gaps of a creak). */
function renderJitter(ctx: BaseAudioContext, rng: Rng): AudioBuffer {
  const len = 2 * LOW_SR;
  const d = seamless(len, Math.round(0.02 * LOW_SR), (o) => {
    let v = 0.7;
    let target = 0.7;
    let hold = 0;
    for (let i = 0; i < o.length; i++) {
      if (--hold <= 0) {
        hold = ((0.004 + rng() * 0.03) * LOW_SR) | 0;
        target = rng() < 0.2 ? rng() * 0.12 : 0.5 + rng() * 0.5;
      }
      v += (target - v) * 0.3;
      o[i] = v;
    }
  });
  return toBuffer(ctx, d, LOW_SR);
}

// ─── Transients ────────────────────────────────────────────────────────

/** Fingernail tap on a window: bright inharmonic ping (2-5 kHz) + faint pane flex. */
function renderTap(ctx: BaseAudioContext, rng: Rng): AudioBuffer {
  const sr = ctx.sampleRate;
  const d = new Float32Array(Math.round(0.1 * sr));
  const f0 = 2300 + rng() * 1400;
  const sc = 0.8 + rng() * 0.4;
  addPartials(
    d,
    sr,
    0,
    [
      { f: f0, a: 1, tau: 0.034 * sc },
      { f: f0 * (1.47 + rng() * 0.12), a: 0.55, tau: 0.024 * sc },
      { f: f0 * (2.13 + rng() * 0.15), a: 0.32, tau: 0.016 * sc },
      { f: f0 * (2.91 + rng() * 0.2), a: 0.18, tau: 0.01 * sc },
      // the pane itself flexing: a faint low "tuk"
      { f: 170 + rng() * 150, a: 0.22, tau: 0.028 },
    ],
    rng,
  );
  addClick(d, sr, 0, 1.2, 0.0006, rng);
  fadeIn(d, 0.0002 * sr);
  fadeOutTail(d, 0.005 * sr);
  return toBuffer(ctx, normalize(d, 0.9), sr);
}

/** Knuckle on a wooden door: low thump with pitch drop + panel resonance + click. */
function renderKnock(ctx: BaseAudioContext, rng: Rng, variant: number): AudioBuffer {
  const sr = ctx.sampleRate;
  const n = Math.round(0.5 * sr);
  const d = new Float32Array(n);
  const exc = new Float32Array(n);
  {
    const k = Math.exp(-1 / (0.003 * sr));
    let e = 1;
    for (let i = 0; i < n && e > 1e-5; i++) {
      exc[i] = (rng() * 2 - 1) * e;
      e *= k;
    }
  }
  const wood = new Float32Array(n);
  addResonator(exc, wood, sr, 240 + variant * 40 + rng() * 40, 0.06, 1.0); // door panel
  addResonator(exc, wood, sr, 560 + rng() * 160, 0.035, 0.7);
  addResonator(exc, wood, sr, 1250 + rng() * 300, 0.018, 0.4);
  normalize(wood, 1);
  addThump(d, sr, 0, 118 + rng() * 12, 64 + rng() * 8, 0.03, 0.5, 0.1, 0.0015);
  for (let i = 0; i < n; i++) d[i] += wood[i] * 1.0;
  addClick(d, sr, 0, 0.6, 0.0008, rng);
  for (let i = 0; i < n; i++) d[i] = Math.tanh(1.5 * d[i]);
  fadeOutTail(d, 0.03 * sr);
  return toBuffer(ctx, normalize(d, 0.9), sr);
}

/** Small metal click (door-handle rattle, pipe tick). */
function renderMetalClick(ctx: BaseAudioContext, rng: Rng): AudioBuffer {
  const sr = ctx.sampleRate;
  const d = new Float32Array(Math.round(0.06 * sr));
  const base = 1600 + rng() * 900;
  addPartials(
    d,
    sr,
    0,
    [
      { f: base, a: 1, tau: 0.011 },
      { f: base * 1.62, a: 0.75, tau: 0.008 },
      { f: base * 2.41, a: 0.5, tau: 0.0055 },
      { f: base * 3.3, a: 0.3, tau: 0.004 },
      { f: 650 + rng() * 300, a: 0.45, tau: 0.007 },
    ],
    rng,
  );
  addClick(d, sr, 0, 1.4, 0.0005, rng);
  fadeOutTail(d, 0.004 * sr);
  return toBuffer(ctx, normalize(d, 0.9), sr);
}

/** Door latch: a heavier metal clunk, then the bolt seating. */
function renderLatch(ctx: BaseAudioContext, rng: Rng): AudioBuffer {
  const sr = ctx.sampleRate;
  const d = new Float32Array(Math.round(0.3 * sr));
  const hit = (start: number, amp: number, mul: number): void => {
    addClick(d, sr, start, 1.2 * amp, 0.0006, rng);
    addPartials(
      d,
      sr,
      start,
      [
        { f: 620 * mul, a: amp, tau: 0.045 },
        { f: 1340 * mul, a: 0.6 * amp, tau: 0.03 },
        { f: 2280 * mul, a: 0.4 * amp, tau: 0.018 },
        { f: 3550 * mul, a: 0.25 * amp, tau: 0.01 },
      ],
      rng,
    );
    addThump(d, sr, start, 150, 110, 0.02, 0.7 * amp, 0.03, 0.001);
  };
  hit(0, 1, 1);
  hit(Math.round(0.02 * sr), 0.5, 1.05);
  fadeOutTail(d, 0.02 * sr);
  return toBuffer(ctx, normalize(d, 0.9), sr);
}

/** Small plastic/metal switch: two transients a few ms apart. */
function renderSwitch(ctx: BaseAudioContext, rng: Rng, off: boolean): AudioBuffer {
  const sr = ctx.sampleRate;
  const d = new Float32Array(Math.round(0.07 * sr));
  const hit = (start: number, amp: number, mul: number): void => {
    addClick(d, sr, start, 1.2 * amp, 0.0004, rng);
    addPartials(
      d,
      sr,
      start,
      [
        { f: 3300 * mul, a: 0.5 * amp, tau: 0.003 },
        { f: 1150 * mul, a: 0.45 * amp, tau: 0.005 },
        { f: 420 * mul, a: 0.3 * amp, tau: 0.009 },
      ],
      rng,
    );
  };
  if (!off) {
    hit(0, 1, 1);
    hit(Math.round(0.011 * sr), 0.55, 1.15);
  } else {
    hit(0, 0.5, 0.9);
    hit(Math.round(0.014 * sr), 0.9, 0.82);
  }
  fadeOutTail(d, 0.004 * sr);
  return toBuffer(ctx, normalize(d, 0.85), sr);
}

/** One heartbeat thump; soft saturation adds harmonics so small speakers carry it. */
function renderBeat(ctx: BaseAudioContext, f0: number, f1: number, decay: number, peak: number): AudioBuffer {
  const sr = ctx.sampleRate;
  const d = new Float32Array(Math.round(0.34 * sr));
  addThump(d, sr, 0, f0, f1, 0.045, 1, decay, 0.004);
  // Chest "body" an octave+ up: the part the Quest's small speakers can play.
  addThump(d, sr, 0, f0 * 2.4, f1 * 2.4, 0.03, 0.3, decay * 0.6, 0.003);
  addThump(d, sr, 0, f0 * 3.8, f1 * 3.8, 0.025, 0.22, decay * 0.45, 0.002);
  let lp = 0;
  for (let i = 0; i < d.length; i++) {
    const x = d[i];
    const v = Math.tanh(2.4 * x + 0.35 * x * x); // asymmetric: adds even harmonics too
    lp += (v - lp) * 0.1; // ~800 Hz one-pole: soft, no click
    d[i] = lp;
  }
  fadeOutTail(d, 0.03 * sr);
  return toBuffer(ctx, normalize(d, peak), sr);
}

function renderTick(ctx: BaseAudioContext, rng: Rng): AudioBuffer {
  const sr = ctx.sampleRate;
  const d = new Float32Array(Math.round(0.08 * sr));
  addClick(d, sr, 0, 0.5, 0.0005, rng);
  addPartials(
    d,
    sr,
    0,
    [
      { f: 1750, a: 0.7, tau: 0.01 },
      { f: 2950, a: 0.3, tau: 0.006 },
      { f: 880, a: 0.3, tau: 0.015 },
    ],
    rng,
  );
  fadeOutTail(d, 0.005 * sr);
  return toBuffer(ctx, normalize(d, 0.7), sr);
}

export function renderBuffers(ctx: BaseAudioContext): SoundBuffers {
  const rng = mulberry32(0x5711);
  return {
    white: renderWhite(ctx, rng),
    pink: renderPink(ctx, rng),
    brown: renderBrown(ctx, rng),
    grit: renderGrit(ctx, rng),
    jitter: renderJitter(ctx, rng),
    taps: [renderTap(ctx, rng), renderTap(ctx, rng), renderTap(ctx, rng), renderTap(ctx, rng)],
    knocks: [renderKnock(ctx, rng, 0), renderKnock(ctx, rng, 1), renderKnock(ctx, rng, 2)],
    clicks: [renderMetalClick(ctx, rng), renderMetalClick(ctx, rng), renderMetalClick(ctx, rng), renderMetalClick(ctx, rng)],
    latch: renderLatch(ctx, rng),
    switchOn: renderSwitch(ctx, rng, false),
    switchOff: renderSwitch(ctx, rng, true),
    lub: renderBeat(ctx, 60, 44, 0.075, 0.9),
    dub: renderBeat(ctx, 74, 52, 0.055, 0.65),
    tick: renderTick(ctx, rng),
  };
}
