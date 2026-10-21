/**
 * The bank's looping sounds. Each is its own small class behind a LoopHandle
 * (M2: swap a class for one that plays recordings, keeping the same
 * setIntensity/stop behaviour). Every loop books its events on the shared
 * lookahead clock, so rhythms stay tight, and everything it creates is
 * released by stop().
 *
 * Intensity 0 is the plain warning (always audible, except the heartbeat and
 * the door creak, which are silent at 0); 1 is maximum urgency.
 */

import { CONFIG } from '../config.js';
import type { LoopHandle } from '../game/contracts.js';
import { clamp01, type Kit, lerp, Loop, pick, rand, SILENT } from './kit.js';
import { creak, squeak } from './voices.js';

const A = CONFIG.audio;
const L = CONFIG.audio.loopLevels;

// ─── Ambience: the night room ─────────────────────────────────────────

const HUM_GAIN = 0.016;

/**
 * Low room tone (brown noise lowpassed ~150 Hz) + a breath of air so small
 * speakers carry something, a faint mains hum with a slow wobble, and
 * occasional distant house creaks / pipe ticks / settling thumps. Its
 * sudden absence is the Listener's warning, so it never stops by itself.
 * Intensity (optional) = dread: the hum swells and the house gets restless.
 */
class Ambience extends Loop {
  private next: number;
  private readonly hum: GainNode;
  private lastX = -1;

  constructor(k: Kit, out: AudioNode) {
    super(k, out, { level: L.ambience, fadeIn: 3, swell: true, smoothSec: 2 });
    const ctx = this.ctx;
    const now = ctx.currentTime;
    const b = k.b;

    // Room tone.
    const room = this.keepSource(new AudioBufferSourceNode(ctx, { buffer: b.brown, loop: true }));
    const roomHp = this.keep(new BiquadFilterNode(ctx, { type: 'highpass', frequency: 28, Q: 0.5 }));
    const roomLp = this.keep(new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 150, Q: 0.4 }));
    const roomG = this.keep(new GainNode(ctx, { gain: 0.2 }));
    room.connect(roomHp).connect(roomLp).connect(roomG).connect(this.bus);
    room.start(now, Math.random() * b.brown.duration * 0.9);

    // Air: very faint mid-band so the Quest's small speakers carry the room too.
    const air = this.keepSource(new AudioBufferSourceNode(ctx, { buffer: b.pink, loop: true }));
    const airBp = this.keep(new BiquadFilterNode(ctx, { type: 'bandpass', frequency: 450, Q: 0.5 }));
    const airG = this.keep(new GainNode(ctx, { gain: 0.05 }));
    air.connect(airBp).connect(airG).connect(this.bus);
    air.start(now, Math.random() * b.pink.duration * 0.9);

    // Mains hum: buzzy saw + strong 2nd harmonic, lowpassed; slow wobble and drift.
    const hz = (Math.random() < 0.5 ? 50 : 60) + rand(-0.3, 0.3);
    const saw = this.keepSource(new OscillatorNode(ctx, { type: 'sawtooth', frequency: hz }));
    const second = this.keepSource(new OscillatorNode(ctx, { type: 'sine', frequency: hz * 2 }));
    const secondG = this.keep(new GainNode(ctx, { gain: 0.6 }));
    const humLp = this.keep(new BiquadFilterNode(ctx, { type: 'lowpass', frequency: 320, Q: 1.5 }));
    this.hum = this.keep(new GainNode(ctx, { gain: HUM_GAIN }));
    saw.connect(humLp);
    second.connect(secondG).connect(humLp);
    humLp.connect(this.hum).connect(this.bus);
    const wobble = this.keepSource(new OscillatorNode(ctx, { type: 'sine', frequency: rand(0.08, 0.14) }));
    const wobbleG = this.keep(new GainNode(ctx, { gain: HUM_GAIN * 0.4 }));
    wobble.connect(wobbleG).connect(this.hum.gain);
    const drift = this.keepSource(new OscillatorNode(ctx, { type: 'sine', frequency: rand(0.035, 0.06) }));
    const driftG = this.keep(new GainNode(ctx, { gain: 5 })); // cents
    drift.connect(driftG);
    driftG.connect(saw.detune);
    driftG.connect(second.detune);
    saw.start(now);
    second.start(now);
    wobble.start(now);
    drift.start(now);

    this.next = now + rand(A.ambienceEventMinSec * 0.4, A.ambienceEventMaxSec * 0.6);
  }

  protected tick(now: number, horizon: number): void {
    const x = this.x;
    if (Math.abs(x - this.lastX) > 0.01) {
      this.hum.gain.setTargetAtTime(HUM_GAIN * (1 + 0.8 * x), now, 0.6);
      this.lastX = x;
    }
    let next = this.catchUp(this.next, now);
    while (next < horizon) {
      this.houseEvent(next, x);
      next += rand(A.ambienceEventMinSec, A.ambienceEventMaxSec) * (1 - 0.4 * x);
    }
    this.next = next;
  }

  private houseEvent(t: number, x: number): void {
    const k = this.k;
    const b = k.b;
    const pan = rand(-0.9, 0.9);
    const r = Math.random();
    if (r < 0.4) {
      // A floorboard or door somewhere else in the house.
      creak(k, this.bus, t, { dur: rand(0.4, 1.1), gain: rand(0.05, 0.1) * (1 + 0.5 * x), pitch: rand(0.7, 1.1), lp: 1400, pan }, this.live);
    } else if (r < 0.78) {
      // Pipes / timber ticking as the house cools: 1-4 irregular ticks.
      const metal = Math.random() < 0.5;
      const n = 1 + ((Math.random() * 4) | 0);
      let tt = t;
      for (let i = 0; i < n; i++) {
        k.sample(
          this.bus,
          tt,
          metal ? pick(b.clicks) : pick(b.knocks),
          rand(0.03, 0.07),
          { rate: metal ? rand(0.6, 0.9) : rand(2.2, 3.2), lp: metal ? 2600 : 1800, pan },
          this.live,
        );
        tt += rand(0.25, 0.9);
      }
    } else {
      // Something settling, far off.
      k.sample(this.bus, t, pick(b.knocks), rand(0.05, 0.09), { rate: rand(0.45, 0.6), lp: 380, pan }, this.live);
    }
  }
}

// ─── Scratching: fingernails under the desk ───────────────────────────

/**
 * Irregular strokes (80-400 ms) of the grit texture through a 1.5-5 kHz
 * bandpass plus a quieter "wood" band, in clusters with pauses; now and
 * then a small knock against the underside of the desk. Intensity raises
 * stroke rate, loudness and harshness (faster grit, wider and higher band,
 * an extra top layer).
 */
class Scratching extends Loop {
  private next: number;
  private left = 0;

  constructor(k: Kit, out: AudioNode) {
    super(k, out, { level: L.scratching, fadeIn: 0.12, smoothSec: 0.3 });
    this.next = this.ctx.currentTime + 0.03;
  }

  protected tick(now: number, horizon: number): void {
    let next = this.catchUp(this.next, now);
    while (next < horizon) {
      const x = this.x;
      if (this.left <= 0) {
        this.left = 2 + ((Math.random() * (3 + 4 * x)) | 0);
        if (Math.random() < 0.15 + 0.25 * x) this.knock(next, x);
      }
      const dur = rand(0.08, 0.4) * (1 - 0.35 * x);
      this.stroke(next, dur, x);
      this.left--;
      const gap = this.left > 0 ? rand(0.03, 0.16) * (1 - 0.4 * x) : rand(0.35, 1.6) * (1 - 0.75 * x) + 0.05;
      next += dur + gap;
    }
    this.next = next;
  }

  private stroke(t: number, dur: number, x: number): void {
    const k = this.k;
    if (k.busy) return;
    const g = k.group(this.live);
    const env = g.gain(0, this.bus);
    const center = rand(1500, 3300) * (1 + 0.5 * x);
    const bp = g.filter('bandpass', center, Math.max(0.8, rand(1.3, 2.6) - 0.7 * x), env);
    bp.frequency.setValueAtTime(center, t);
    bp.frequency.linearRampToValueAtTime(Math.min(5200, center * rand(0.7, 1.35)), t + dur);
    const wood = g.filter('bandpass', rand(650, 950), 2);
    const woodG = g.gain(0.35, env);
    wood.connect(woodG);
    const s = g.buffer(k.b.grit, true, rand(0.75, 1.05) + 0.45 * x);
    s.connect(bp);
    s.connect(wood);
    if (x > 0.45 && Math.random() < x) {
      const top = g.filter('highpass', 4200, 0.8);
      const topG = g.gain(0.5 * x, env);
      s.connect(top);
      top.connect(topG);
    }
    // Irregular pressure through the stroke.
    const peak = rand(0.35, 0.8) * (0.55 + 0.6 * x);
    const a = rand(0.008, 0.05);
    const p = env.gain;
    p.setValueAtTime(0, t);
    p.linearRampToValueAtTime(peak, t + a);
    p.linearRampToValueAtTime(peak * rand(0.45, 1.1), t + a + (dur - a) * rand(0.35, 0.7));
    p.linearRampToValueAtTime(peak * rand(0.5, 1), t + dur);
    p.exponentialRampToValueAtTime(SILENT, t + dur + rand(0.02, 0.06));
    s.start(t, Math.random() * k.b.grit.duration * 0.9);
    s.stop(t + dur + 0.08);
  }

  private knock(t: number, x: number): void {
    const b = this.k.b;
    this.k.sample(this.bus, t, pick(b.knocks), rand(0.25, 0.45) * (0.7 + 0.5 * x), { rate: rand(1.6, 2.3), lp: 2600 }, this.live);
  }
}

// ─── Glass taps: a fingernail on the window ───────────────────────────

/** Onset times (s) of tap motifs at intensity 0. */
const MOTIFS: readonly (readonly number[])[] = [
  [0, 0.13, 0.25, 1.05], // three quick, pause, one
  [0, 0.42], // two, slow
  [0], // one
  [0, 0.75, 0.88], // one ... two quick
  [0, 0.16, 0.95, 1.1, 1.24], // two, pause, three
  [0, 0.55, 1.1], // slow and even: patient
];
/** Fingernails drumming (high intensity). */
const DRUM: readonly number[] = [0, 0.1, 0.19, 0.29, 0.38];

/**
 * Short bright inharmonic pings (pre-rendered, 15-40 ms decays) in uneasy
 * irregular motifs, with the odd nail bounce; at high intensity a faint
 * squeak of skin on glass. Intensity raises tempo and density.
 */
class GlassTaps extends Loop {
  private next: number;
  private motif: readonly number[] = MOTIFS[0];
  private motifIndex = 0;
  private step = 0;

  constructor(k: Kit, out: AudioNode) {
    super(k, out, { level: L.glassTaps, fadeIn: 0.02, smoothSec: 0.5 });
    this.next = this.ctx.currentTime + 0.05;
  }

  protected tick(now: number, horizon: number): void {
    let next = this.catchUp(this.next, now);
    while (next < horizon) {
      const x = this.x;
      const m = this.motif;
      const i = this.step;
      const lone = i > 0 && m[i] - m[i - 1] > 0.5; // the one after a pause lands harder
      this.tap(next, (lone ? 1.15 : 1) * rand(0.7, 1) * (0.7 + 0.4 * x));
      if (i < m.length - 1) {
        next += ((m[i + 1] - m[i]) * rand(0.88, 1.12)) / (1 + 0.7 * x);
        this.step++;
      } else {
        if (x > 0.5 && Math.random() < (x - 0.4) * 0.7) {
          squeak(this.k, this.bus, next + rand(0.25, 0.5), { dur: rand(0.3, 0.8), gain: rand(0.05, 0.1) * x }, this.live);
        }
        this.pickMotif(x);
        this.step = 0;
        next += rand(1.4, 3.6) * (1 - 0.7 * x) + 0.25;
      }
    }
    this.next = next;
  }

  private tap(t: number, v: number): void {
    const k = this.k;
    k.sample(this.bus, t, pick(k.b.taps), v * 0.9, { rate: rand(0.9, 1.12) }, this.live);
    if (Math.random() < 0.2) {
      // The nail bouncing.
      k.sample(this.bus, t + rand(0.012, 0.02), pick(k.b.taps), v * 0.3, { rate: rand(1.0, 1.2) }, this.live);
    }
  }

  private pickMotif(x: number): void {
    if (x > 0.6 && Math.random() < 0.35) {
      this.motif = DRUM;
      return;
    }
    let i = (Math.random() * MOTIFS.length) | 0;
    if (i === this.motifIndex) i = (i + 1) % MOTIFS.length;
    this.motifIndex = i;
    this.motif = MOTIFS[i];
  }
}

// ─── Door knocks: handle rattle, then knocking ────────────────────────

/**
 * First the handle rattles (rapid metal clicks swelling and fading, ending
 * in the latch dropping back), then slow heavy knocks on wood in groups.
 * Intensity raises knock rate, group size and force (lower, brighter,
 * louder), and brings rattles back between knock groups.
 */
class DoorKnocks extends Loop {
  private rattling = true;
  private next: number;
  private rattleStart: number;
  private rattleEnd: number;
  private left = 0;

  constructor(k: Kit, out: AudioNode) {
    super(k, out, { level: L.doorKnocks, fadeIn: 0.02, smoothSec: 0.4 });
    const now = this.ctx.currentTime;
    this.rattleStart = now + 0.05;
    this.next = this.rattleStart;
    this.rattleEnd = this.rattleStart + rand(1.1, 1.7);
  }

  protected tick(now: number, horizon: number): void {
    const k = this.k;
    const b = k.b;
    let next = this.catchUp(this.next, now);
    while (next < horizon) {
      const x = this.x;
      if (this.rattling) {
        if (next >= this.rattleEnd) {
          // Handle released: the latch drops back.
          k.sample(this.bus, next, b.latch, rand(0.35, 0.5), { rate: rand(0.95, 1.08) }, this.live);
          this.rattling = false;
          this.left = 0;
          next += rand(0.5, 1.0) * (1 - 0.5 * x);
          continue;
        }
        const prog = clamp01((next - this.rattleStart) / Math.max(0.01, this.rattleEnd - this.rattleStart));
        const shape = Math.sqrt(Math.sin(Math.PI * prog));
        k.sample(this.bus, next, pick(b.clicks), (0.2 + 0.4 * shape) * rand(0.6, 1) * (0.8 + 0.4 * x), { rate: rand(0.85, 1.2) }, this.live);
        next += Math.random() < 0.1 ? rand(0.08, 0.2) : rand(0.022, 0.05);
      } else {
        if (this.left <= 0) this.left = 2 + ((Math.random() * (2 + 2.5 * x)) | 0);
        this.knock(next, rand(0.75, 1) * (0.6 + 0.45 * x));
        this.left--;
        if (this.left > 0) {
          next += rand(0.33, 0.55) * (1 - 0.3 * x);
        } else {
          const gap = rand(1.6, 3.0) * (1 - 0.6 * x) + 0.3;
          if (Math.random() < 0.85 * x) {
            this.rattling = true;
            this.rattleStart = next + gap * rand(0.3, 0.5);
            this.rattleEnd = this.rattleStart + rand(0.4, 0.9);
            next = this.rattleStart;
          } else {
            next += gap;
          }
        }
      }
    }
    this.next = next;
  }

  private knock(t: number, force: number): void {
    const k = this.k;
    const b = k.b;
    k.sample(this.bus, t, pick(b.knocks), force, { rate: rand(0.92, 1.05) - 0.06 * force, lp: 1800 + 4200 * force }, this.live);
    if (force > 0.8) {
      // The latch rattling in its keeper from the blow.
      k.sample(this.bus, t + rand(0.012, 0.025), pick(b.clicks), force * 0.18, { rate: rand(0.7, 0.9) }, this.live);
    }
  }
}

// ─── Door creak: the door easing open ─────────────────────────────────

/**
 * Creaks only while the door is MOVING (intensity rising): each creak grows
 * longer, louder and deeper the further open the door is. Holding steady is
 * silent (the tension of a door left ajar), with a rare faint shift in the
 * draught once it is well open. Intensity 0 = shut, 1 = about to burst.
 */
class DoorCreak extends Loop {
  private prevX = -1;
  private moved = 0;
  private busyUntil = 0;
  private nextIdle: number;

  constructor(k: Kit, out: AudioNode) {
    super(k, out, { level: L.doorCreak, fadeIn: 0.03, smoothSec: 0.25 });
    this.nextIdle = this.ctx.currentTime + rand(3, 6);
  }

  protected tick(now: number, horizon: number): void {
    const x = this.x;
    if (this.prevX < 0) this.prevX = x;
    const dx = x - this.prevX;
    this.prevX = x;
    if (dx > 0) this.moved += dx;
    else if (dx < -0.002) this.moved = 0;

    const t = Math.max(now + 0.01, this.busyUntil);
    if (t >= horizon) return;
    if (this.moved >= 0.03) {
      const dur = lerp(0.6, 2.2, x) * rand(0.8, 1.2);
      creak(this.k, this.bus, t, { dur, gain: lerp(0.3, 0.9, x) * rand(0.85, 1), pitch: lerp(1.15, 0.78, x) * rand(0.95, 1.05) }, this.live);
      this.moved = 0;
      this.busyUntil = t + dur * rand(0.75, 0.95);
    } else if (x > 0.25 && now > this.nextIdle) {
      const dur = rand(0.4, 0.9);
      creak(this.k, this.bus, t, { dur, gain: 0.18 * x, pitch: rand(0.9, 1.2) }, this.live);
      this.nextIdle = now + rand(4, 9);
      this.busyUntil = t + dur;
    }
  }
}

// ─── Ringing: the Listener's silence ──────────────────────────────────

/**
 * Tinnitus: two quiet sines at 6.8-7.6 kHz beating a couple of times a
 * second, both drifting slowly in pitch, swelling in over
 * CONFIG.audio.ringingSwellSec at CONFIG.audio.ringingGain. Intensity only
 * quickens the beating (never louder, so the mic doesn't hear more of it).
 */
class Ringing extends Loop {
  private readonly upper: OscillatorNode;
  private readonly f: number;
  private lastX = -1;

  constructor(k: Kit, out: AudioNode) {
    super(k, out, { level: A.ringingGain, fadeIn: A.ringingSwellSec, swell: true, smoothSec: 1.5 });
    const ctx = this.ctx;
    const now = ctx.currentTime;
    this.f = rand(6800, 7600);
    const lower = this.keepSource(new OscillatorNode(ctx, { type: 'sine', frequency: this.f }));
    this.upper = this.keepSource(new OscillatorNode(ctx, { type: 'sine', frequency: this.f + 2.2 }));
    const lg = this.keep(new GainNode(ctx, { gain: 0.55 }));
    const ug = this.keep(new GainNode(ctx, { gain: 0.45 }));
    lower.connect(lg).connect(this.bus);
    this.upper.connect(ug).connect(this.bus);
    const drift = this.keepSource(new OscillatorNode(ctx, { type: 'sine', frequency: rand(0.05, 0.08) }));
    const driftG = this.keep(new GainNode(ctx, { gain: 8 })); // cents, applied to both: the beat stays slight
    drift.connect(driftG);
    driftG.connect(lower.detune);
    driftG.connect(this.upper.detune);
    lower.start(now);
    this.upper.start(now);
    drift.start(now);
  }

  protected tick(now: number): void {
    const x = this.x;
    if (Math.abs(x - this.lastX) > 0.01) {
      this.upper.frequency.setTargetAtTime(this.f + lerp(2.2, 6, x), now, 0.8);
      this.lastX = x;
    }
  }
}

// ─── Heartbeat ────────────────────────────────────────────────────────

/** Soft lub-dub, CONFIG.audio.heartbeatBpmMin -> Max with intensity; silent at 0. */
class Heartbeat extends Loop {
  private next: number;

  constructor(k: Kit, out: AudioNode) {
    super(k, out, { level: L.heartbeat, fadeIn: 0.05, smoothSec: 1.2 });
    this.next = this.ctx.currentTime + 0.1;
  }

  protected tick(now: number, horizon: number): void {
    const k = this.k;
    let next = this.catchUp(this.next, now);
    while (next < horizon) {
      const x = this.x;
      if (x > 0.01) {
        const v = Math.min(1, x / 0.15) * (0.35 + 0.65 * x);
        k.sample(this.bus, next, k.b.lub, v, { rate: rand(0.98, 1.02) }, this.live);
        k.sample(this.bus, next + lerp(0.3, 0.22, x), k.b.dub, v * 0.8, undefined, this.live);
      }
      next += (60 / lerp(A.heartbeatBpmMin, A.heartbeatBpmMax, x)) * rand(0.97, 1.03);
    }
    this.next = next;
  }
}

// ─── Factories ────────────────────────────────────────────────────────

export const ambienceLoop = (k: Kit, out: AudioNode): LoopHandle => new Ambience(k, out);
export const scratchingLoop = (k: Kit, out: AudioNode): LoopHandle => new Scratching(k, out);
export const glassTapsLoop = (k: Kit, out: AudioNode): LoopHandle => new GlassTaps(k, out);
export const doorKnocksLoop = (k: Kit, out: AudioNode): LoopHandle => new DoorKnocks(k, out);
export const doorCreakLoop = (k: Kit, out: AudioNode): LoopHandle => new DoorCreak(k, out);
export const ringingLoop = (k: Kit, out: AudioNode): LoopHandle => new Ringing(k, out);
export const heartbeatLoop = (k: Kit, out: AudioNode): LoopHandle => new Heartbeat(k, out);
