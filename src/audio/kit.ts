/**
 * Procedural-audio plumbing shared by every sound in the bank:
 *
 * - `LookaheadClock`: one timer (CONFIG.audio.schedulerIntervalMs) for the
 *   whole bank that asks each running loop to book its events up to
 *   CONFIG.audio.schedulerLookaheadSec ahead on the AudioContext clock. The
 *   engine also pumps it every frame, so timing stays tight even if the
 *   browser throttles timers.
 * - `Group`: the nodes of one short-lived sound event; disconnects itself
 *   when its last source ends.
 * - `Kit`: the shared buffers plus tiny synthesis primitives (sample, noise,
 *   tone).
 * - `Loop`: the base class behind every LoopHandle (smoothed intensity,
 *   fade in / fade out, full release of nodes and timers).
 */

import { CONFIG } from '../config.js';
import type { LoopHandle } from '../game/contracts.js';
import { renderBuffers, type SoundBuffers } from './buffers.js';

/** Floor for exponential ramps (−80 dB). */
export const SILENT = 0.0001;

// ─── Small math helpers ───────────────────────────────────────────────

export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Uniform in [a, b). Runtime variation only (buffers are seeded). */
export function rand(a: number, b: number): number {
  return a + Math.random() * (b - a);
}

export function pick<T>(arr: readonly T[]): T {
  return arr[(Math.random() * arr.length) | 0] as T;
}

// ─── AudioParam helpers ───────────────────────────────────────────────

/** Cancel future automation and hold the current value (Firefox lacks cancelAndHoldAtTime). */
export function holdParam(p: AudioParam, t: number): void {
  if (typeof p.cancelAndHoldAtTime === 'function') {
    p.cancelAndHoldAtTime(t);
  } else {
    const v = p.value;
    p.cancelScheduledValues(t);
    p.setValueAtTime(v, t);
  }
}

/** Linear ramp from wherever the param is now. */
export function rampParam(p: AudioParam, value: number, t: number, sec: number): void {
  holdParam(p, t);
  p.linearRampToValueAtTime(value, t + Math.max(0.005, sec));
}

/** 0 -> peak (linear attack), hold, exponential release to silence. */
export function envelope(p: AudioParam, t: number, peak: number, attack: number, hold: number, release: number): void {
  const pk = Math.max(peak, SILENT * 2);
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(pk, t + Math.max(0.001, attack));
  if (hold > 0) p.setValueAtTime(pk, t + attack + hold);
  p.exponentialRampToValueAtTime(SILENT, t + attack + hold + Math.max(0.005, release));
}

/** A perceptually even swell 0 -> level (piecewise, roughly quadratic). */
export function swellParam(p: AudioParam, t: number, level: number, sec: number): void {
  const s = Math.max(0.01, sec);
  p.setValueAtTime(0, t);
  p.linearRampToValueAtTime(level * 0.06, t + s * 0.25);
  p.linearRampToValueAtTime(level * 0.25, t + s * 0.5);
  p.linearRampToValueAtTime(level * 0.56, t + s * 0.75);
  p.linearRampToValueAtTime(level, t + s);
}

// ─── Lookahead clock ──────────────────────────────────────────────────

export interface Scheduled {
  /** Book every event that falls before `horizon` (ctx seconds). */
  schedule(now: number, horizon: number): void;
}

export class LookaheadClock {
  private readonly items: Scheduled[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastPump = -1;
  private readonly onTimer = (): void => this.pump(true);

  constructor(
    private readonly ctx: AudioContext,
    private readonly lookaheadSec: number,
    private readonly intervalMs: number,
  ) {}

  get count(): number {
    return this.items.length;
  }

  add(s: Scheduled): void {
    if (this.items.indexOf(s) < 0) this.items.push(s);
    if (this.timer === null) this.timer = setInterval(this.onTimer, this.intervalMs);
  }

  remove(s: Scheduled): void {
    const i = this.items.indexOf(s);
    if (i >= 0) this.items.splice(i, 1);
    if (this.items.length === 0 && this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Allocation-free; safe to call every frame. */
  pump(force = false): void {
    const n = this.items.length;
    if (n === 0 || this.ctx.state !== 'running') return;
    const now = this.ctx.currentTime;
    if (!force && now - this.lastPump < 0.008) return;
    this.lastPump = now;
    const horizon = now + this.lookaheadSec;
    for (let i = n - 1; i >= 0; i--) this.items[i]?.schedule(now, horizon);
  }
}

// ─── Short-lived node groups ──────────────────────────────────────────

export type SourceSet = Set<AudioScheduledSourceNode>;

/**
 * The nodes of one sound event. Register every source with `src()` (and
 * start it); when the last one ends, every node in the group is
 * disconnected. `owner` (a loop's live set) lets a loop stop its in-flight
 * events on release.
 */
export class Group {
  private readonly nodes: AudioNode[] = [];
  private pending = 0;
  private freed = false;

  constructor(
    private readonly k: Kit,
    private readonly owner: SourceSet | null,
  ) {
    k.live++;
  }

  get ctx(): AudioContext {
    return this.k.ctx;
  }

  add<T extends AudioNode>(n: T): T {
    this.nodes.push(n);
    return n;
  }

  src<T extends AudioScheduledSourceNode>(s: T): T {
    this.nodes.push(s);
    this.pending++;
    const owner = this.owner;
    owner?.add(s);
    s.onended = () => {
      owner?.delete(s);
      if (--this.pending <= 0) this.free();
    };
    return s;
  }

  gain(value: number, dest?: AudioNode): GainNode {
    const g = this.add(new GainNode(this.k.ctx, { gain: value }));
    if (dest) g.connect(dest);
    return g;
  }

  filter(type: BiquadFilterType, freq: number, q = 0.7, dest?: AudioNode): BiquadFilterNode {
    const f = this.add(new BiquadFilterNode(this.k.ctx, { type, frequency: freq, Q: q }));
    if (dest) f.connect(dest);
    return f;
  }

  pan(value: number, dest: AudioNode): StereoPannerNode {
    const p = this.add(new StereoPannerNode(this.k.ctx, { pan: Math.max(-1, Math.min(1, value)) }));
    p.connect(dest);
    return p;
  }

  shaper(dest?: AudioNode): WaveShaperNode {
    const w = this.add(new WaveShaperNode(this.k.ctx, { curve: this.k.drive, oversample: 'none' }));
    if (dest) w.connect(dest);
    return w;
  }

  buffer(buf: AudioBuffer, loop: boolean, rate = 1): AudioBufferSourceNode {
    return this.src(new AudioBufferSourceNode(this.k.ctx, { buffer: buf, loop, playbackRate: rate }));
  }

  osc(type: OscillatorType, freq: number, detune = 0): OscillatorNode {
    return this.src(new OscillatorNode(this.k.ctx, { type, frequency: freq, detune }));
  }

  private free(): void {
    if (this.freed) return;
    this.freed = true;
    this.k.live--;
    for (const n of this.nodes) {
      try {
        n.disconnect();
      } catch {
        /* already disconnected */
      }
    }
    this.nodes.length = 0;
  }
}

// ─── Kit: buffers + primitives ────────────────────────────────────────

export interface SampleOpts {
  rate?: number;
  /** Lowpass cutoff (Hz); omit for none. */
  lp?: number;
  /** Highpass cutoff (Hz); omit for none. */
  hp?: number;
  /** Stereo pan (-1..1), only meaningful on non-spatial outputs. */
  pan?: number;
}

export interface NoiseOpts {
  /** Default: white. */
  buf?: AudioBuffer;
  gain: number;
  attack: number;
  hold?: number;
  release: number;
  type?: BiquadFilterType;
  freq?: number;
  /** Sweep the filter to this frequency over the sound (exponential). */
  freqTo?: number;
  q?: number;
  rate?: number;
  pan?: number;
}

export interface ToneOpts {
  type?: OscillatorType;
  freq: number;
  /** Glide to this frequency (exponential) over `glide` seconds (default: whole sound). */
  freqTo?: number;
  glide?: number;
  detune?: number;
  gain: number;
  attack: number;
  hold?: number;
  release: number;
  /** Optional lowpass (Hz). */
  lp?: number;
}

export class Kit {
  readonly b: SoundBuffers;
  readonly clock: LookaheadClock;
  /** Soft-clip curve shared by every WaveShaper (tanh(3x), normalised). */
  readonly drive: Float32Array<ArrayBuffer>;
  /** Live transient groups across the whole bank. */
  live = 0;
  /** Running loops (for stopAll). */
  readonly loops = new Set<Loop>();

  constructor(readonly ctx: AudioContext) {
    this.b = renderBuffers(ctx);
    this.clock = new LookaheadClock(ctx, CONFIG.audio.schedulerLookaheadSec, CONFIG.audio.schedulerIntervalMs);
    const n = 1024;
    this.drive = new Float32Array(n);
    const norm = Math.tanh(3);
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      this.drive[i] = Math.tanh(3 * x) / norm;
    }
  }

  /** Too many transient sounds alive: loops should skip optional events. */
  get busy(): boolean {
    return this.live >= CONFIG.audio.maxLiveEvents;
  }

  group(owner: SourceSet | null = null): Group {
    return new Group(this, owner);
  }

  /** Play a (pre-rendered) buffer once. */
  sample(dest: AudioNode, t: number, buf: AudioBuffer, gain: number, o?: SampleOpts, owner: SourceSet | null = null): void {
    if (gain <= SILENT) return;
    const g = this.group(owner);
    let head: AudioNode = o?.pan !== undefined ? g.pan(o.pan, dest) : dest;
    head = g.gain(gain, head);
    if (o?.lp) head = g.filter('lowpass', o.lp, 0.7, head);
    if (o?.hp) head = g.filter('highpass', o.hp, 0.7, head);
    const s = g.buffer(buf, false, o?.rate ?? 1);
    s.connect(head);
    s.start(t);
  }

  /** A burst of noise through an optional (sweeping) filter with an AR envelope. */
  noise(dest: AudioNode, t: number, o: NoiseOpts, owner: SourceSet | null = null): void {
    if (o.gain <= SILENT) return;
    const g = this.group(owner);
    const buf = o.buf ?? this.b.white;
    const hold = o.hold ?? 0;
    const dur = o.attack + hold + o.release;
    const out = o.pan !== undefined ? g.pan(o.pan, dest) : dest;
    const env = g.gain(0, out);
    let head: AudioNode = env;
    if (o.type) {
      const f = g.filter(o.type, o.freq ?? 1000, o.q ?? 0.7, env);
      if (o.freqTo) {
        f.frequency.setValueAtTime(o.freq ?? 1000, t);
        f.frequency.exponentialRampToValueAtTime(Math.max(20, o.freqTo), t + dur);
      }
      head = f;
    }
    const s = g.buffer(buf, true, o.rate ?? 1);
    s.connect(head);
    envelope(env.gain, t, o.gain, o.attack, hold, o.release);
    s.start(t, Math.random() * buf.duration * 0.9);
    s.stop(t + dur + 0.02);
  }

  /** An oscillator note with optional pitch glide and lowpass. */
  tone(dest: AudioNode, t: number, o: ToneOpts, owner: SourceSet | null = null): void {
    if (o.gain <= SILENT) return;
    const g = this.group(owner);
    const hold = o.hold ?? 0;
    const dur = o.attack + hold + o.release;
    const env = g.gain(0, dest);
    let head: AudioNode = env;
    if (o.lp) head = g.filter('lowpass', o.lp, 0.7, env);
    const osc = g.osc(o.type ?? 'sine', o.freq, o.detune ?? 0);
    if (o.freqTo) {
      osc.frequency.setValueAtTime(o.freq, t);
      osc.frequency.exponentialRampToValueAtTime(Math.max(1, o.freqTo), t + (o.glide ?? dur));
    }
    osc.connect(head);
    envelope(env.gain, t, o.gain, o.attack, hold, o.release);
    osc.start(t);
    osc.stop(t + dur + 0.02);
  }
}

// ─── Loop base ────────────────────────────────────────────────────────

export interface LoopOpts {
  /** Output level once faded in. */
  level: number;
  /** Fade-in seconds (default 0.05). */
  fadeIn?: number;
  /** Use a slow perceptual swell instead of a linear fade-in. */
  swell?: boolean;
  /** Time constant (s) with which intensity follows setIntensity (default 0.35). */
  smoothSec?: number;
}

/**
 * Base of every LoopHandle. Subclasses build persistent nodes in their
 * constructor (registering them with keep()/keepSource()) and book events in
 * tick(). setIntensity() only stores a number (cheap to call every frame);
 * the smoothed value `x` advances on the scheduler's cadence.
 */
export abstract class Loop implements LoopHandle, Scheduled {
  protected readonly ctx: AudioContext;
  /** Loop output: fades in/out, connected to the caller's `out`. */
  protected readonly bus: GainNode;
  /** Smoothed intensity 0..1. */
  protected x = 0;
  private xTarget = 0;
  private lastNow = -1;
  private readonly smoothSec: number;
  /** In-flight event sources (stopped on release). */
  protected readonly live: SourceSet = new Set();
  private readonly held: AudioNode[] = [];
  private readonly heldSources: AudioScheduledSourceNode[] = [];
  private stopping = false;
  private released = false;
  private releaseTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    protected readonly k: Kit,
    out: AudioNode,
    o: LoopOpts,
  ) {
    this.ctx = k.ctx;
    this.smoothSec = o.smoothSec ?? 0.35;
    this.bus = new GainNode(this.ctx, { gain: 0 });
    this.bus.connect(out);
    const now = this.ctx.currentTime;
    if (o.swell) swellParam(this.bus.gain, now, o.level, o.fadeIn ?? 2);
    else {
      this.bus.gain.setValueAtTime(0, now);
      this.bus.gain.linearRampToValueAtTime(o.level, now + Math.max(0.01, o.fadeIn ?? 0.05));
    }
    k.loops.add(this);
    k.clock.add(this);
  }

  /** Is this loop fading out / released? */
  get stopped(): boolean {
    return this.stopping;
  }

  setIntensity(v: number): void {
    if (!(v === v)) return; // NaN guard
    const c = clamp01(v);
    this.xTarget = c;
    if (this.lastNow < 0) this.x = c;
  }

  schedule(now: number, horizon: number): void {
    if (this.released) return;
    const dt = this.lastNow < 0 ? 0 : Math.max(0, now - this.lastNow);
    this.lastNow = now;
    if (this.x !== this.xTarget) {
      this.x += (this.xTarget - this.x) * (1 - Math.exp(-dt / this.smoothSec));
      if (Math.abs(this.xTarget - this.x) < 0.002) this.x = this.xTarget;
    }
    this.tick(now, horizon);
  }

  /** Book events up to `horizon`. Called every ~25 ms (and every frame). */
  protected abstract tick(now: number, horizon: number): void;

  /** Keep a persistent node (disconnected on release). */
  protected keep<T extends AudioNode>(n: T): T {
    this.held.push(n);
    return n;
  }

  /** Keep a persistent source (stopped + disconnected on release). Start it yourself. */
  protected keepSource<T extends AudioScheduledSourceNode>(s: T): T {
    this.held.push(s);
    this.heldSources.push(s);
    return s;
  }

  stop(fadeSec = 0.4): void {
    if (this.stopping) return;
    this.stopping = true;
    const fade = Math.max(0.01, fadeSec);
    try {
      rampParam(this.bus.gain, 0, this.ctx.currentTime, fade);
    } catch {
      /* closed context */
    }
    this.releaseTimer = setTimeout(() => this.release(), (fade + 0.15) * 1000);
  }

  private release(): void {
    if (this.released) return;
    this.released = true;
    if (this.releaseTimer !== null) clearTimeout(this.releaseTimer);
    this.releaseTimer = null;
    this.k.clock.remove(this);
    this.k.loops.delete(this);
    for (const s of this.heldSources) {
      try {
        s.stop();
      } catch {
        /* never started / already stopped */
      }
    }
    // Stopping an event source fires its onended, which frees its group.
    for (const s of Array.from(this.live)) {
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
    }
    this.live.clear();
    for (const n of this.held) {
      try {
        n.disconnect();
      } catch {
        /* already disconnected */
      }
    }
    this.held.length = 0;
    this.heldSources.length = 0;
    try {
      this.bus.disconnect();
    } catch {
      /* already disconnected */
    }
  }

  /** Book `next` no earlier than now (skip events missed while timers were throttled). */
  protected catchUp(next: number, now: number): number {
    return next < now - 0.02 ? now + 0.005 : next;
  }
}
