/**
 * Shared helpers for the four threat presenters: easing and noise, procedural
 * canvas textures, a glowing-eyes factory, fake "baked" shading for unlit
 * low-poly bodies, and small audio slot wrappers that make sure every spatial
 * voice and loop is released (no leaks over five nights and restarts).
 *
 * Everything here allocates only at construction / init time. The per-frame
 * functions (easing, noise, damp, GlowingEyes.update, LoopSlot.set ...) are
 * allocation-free.
 */

import {
  AdditiveBlending,
  BufferAttribute,
  CanvasTexture,
  Color,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  Quaternion,
  SRGBColorSpace,
  Vector3,
  type BufferGeometry,
  type Object3D,
} from '@iwsdk/core';
import type { AudioEngineLike, LoopHandle, SpatialVoice } from '../game/contracts.js';

// ─── Look constants ───────────────────────────────────────────────────────

/** Quiet-dread palette: near-black blue-grey, pale bone / sickly white, dim amber. */
export const PALETTE = {
  bone: 0xd6cfbd,
  sickly: 0xe6e4cc,
  amber: 0xcfa863,
  sicklyLight: 0xd9d09a,
  glassBlue: 0x8e9cab,
  nearBlack: 0x050608,
} as const;

/**
 * Render orders. The darkness shell uses -1000 and UI text ~900; every threat
 * visual sits between them so it draws over the darkness.
 */
export const RENDER_ORDER = {
  glass: 10,
  light: 12,
  body: 20,
  occluder: 24,
  glow: 30,
  rush: 40,
  rushGlow: 42,
} as const;

// ─── Easing / maths (pure, allocation-free) ───────────────────────────────

export function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

export function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

export function easeInQuad(t: number): number {
  return t * t;
}

export function easeInCubic(t: number): number {
  return t * t * t;
}

export function easeOutCubic(t: number): number {
  const u = 1 - t;
  return 1 - u * u * u;
}

export function easeInOutSine(t: number): number {
  return 0.5 - 0.5 * Math.cos(Math.PI * t);
}

/** Frame-rate independent exponential approach of `current` toward `target`. */
export function damp(current: number, target: number, lambda: number, dt: number): number {
  return target + (current - target) * Math.exp(-lambda * dt);
}

function hash1(n: number): number {
  const s = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
}

/** Jittery value noise in [-1, 1] (twitches, trembles). `freq` = changes per second. */
export function jitter(t: number, seed: number, freq: number): number {
  const x = t * freq + seed * 17.31;
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  return (hash1(i) * (1 - u) + hash1(i + 1) * u) * 2 - 1;
}

/** Slow organic drift in roughly [-1, 1] (breathing, sway). */
export function wobble(t: number, seed: number): number {
  return (
    Math.sin(t * 1.13 + seed) * 0.5 +
    Math.sin(t * 2.37 + seed * 1.7) * 0.3 +
    Math.sin(t * 4.11 + seed * 2.3) * 0.2
  );
}

export function randRange(lo: number, hi: number): number {
  return lo + Math.random() * (hi - lo);
}

export function randSign(): 1 | -1 {
  return Math.random() < 0.5 ? -1 : 1;
}

export function pickRandom<T>(items: readonly T[]): T | null {
  if (items.length === 0) return null;
  return items[Math.floor(Math.random() * items.length)] ?? items[0] ?? null;
}

// ─── Frames ──────────────────────────────────────────────────────────────

const _ax = new Vector3();
const _ay = new Vector3();
const _az = new Vector3();
const _basis = new Matrix4();
const _q = new Quaternion();

/**
 * Orient `obj` so its local +Z is the horizontal part of `forward` and +Y is
 * world up (X = Y × Z). Used for window/door/desk frames.
 */
export function orientToForward(obj: Object3D, forward: Vector3): void {
  _az.set(forward.x, 0, forward.z);
  if (_az.lengthSq() < 1e-8) _az.set(0, 0, 1);
  _az.normalize();
  _ay.set(0, 1, 0);
  _ax.crossVectors(_ay, _az).normalize();
  _basis.makeBasis(_ax, _ay, _az);
  obj.quaternion.setFromRotationMatrix(_basis);
}

/** The head's world right vector. */
export function headRight(head: Object3D, out: Vector3): Vector3 {
  head.getWorldQuaternion(_q);
  return out.set(1, 0, 0).applyQuaternion(_q);
}

/** out = head + forward * dist + (0, dy, 0). */
export function pointInFrontOfHead(headPos: Vector3, headForward: Vector3, dist: number, dy: number, out: Vector3): Vector3 {
  out.copy(headForward).multiplyScalar(dist).add(headPos);
  out.y += dy;
  return out;
}

// ─── Geometry helpers ─────────────────────────────────────────────────────

let unitPlaneGeo: PlaneGeometry | null = null;

/** Shared 1 × 1 quad facing +Z. Scale the mesh to size it. */
export function unitPlane(): PlaneGeometry {
  unitPlaneGeo ??= new PlaneGeometry(1, 1);
  return unitPlaneGeo;
}

export interface ShadeOptions {
  /** Local direction of the fake key light (normalised internally). */
  light: Vector3;
  /** Brightness of faces turned fully away from the light (0..1). */
  min: number;
  /** Optional alpha fade along local Y: alpha 1 at y >= opaqueY, 0 at y <= clearY. */
  fadeY?: { opaqueY: number; clearY: number };
}

/**
 * Bake fake lighting (and optionally an alpha fade) into RGBA vertex colours,
 * so an unlit MeshBasicMaterial({ vertexColors: true }) still reads as a 3D
 * form in the dark without a real light.
 */
export function shadeGeometry(geo: BufferGeometry, color: number, o: ShadeOptions): BufferGeometry {
  if (!geo.getAttribute('normal')) geo.computeVertexNormals();
  const pos = geo.getAttribute('position');
  const nrm = geo.getAttribute('normal');
  const base = new Color(color);
  const light = o.light.clone().normalize();
  const n = new Vector3();
  const data = new Float32Array(pos.count * 4);
  for (let i = 0; i < pos.count; i++) {
    n.set(nrm.getX(i), nrm.getY(i), nrm.getZ(i));
    const lambert = Math.max(0, n.dot(light));
    const shade = o.min + (1 - o.min) * lambert;
    let alpha = 1;
    if (o.fadeY) alpha = smoothstep(o.fadeY.clearY, o.fadeY.opaqueY, pos.getY(i));
    data[i * 4] = base.r * shade;
    data[i * 4 + 1] = base.g * shade;
    data[i * 4 + 2] = base.b * shade;
    data[i * 4 + 3] = alpha;
  }
  geo.setAttribute('color', new BufferAttribute(data, 4));
  return geo;
}

// ─── Canvas textures ──────────────────────────────────────────────────────

/** Draw into a fresh canvas and wrap it as an sRGB texture (init time only). */
export function canvasTexture(
  width: number,
  height: number,
  draw: (g: CanvasRenderingContext2D, w: number, h: number) => void,
): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext('2d');
  if (g) draw(g, width, height);
  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  return tex;
}

/** Elliptical radial gradient fill centred at (cx, cy) with radii (rx, ry). */
export function fillEllipseGradient(
  g: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  stops: ReadonlyArray<readonly [number, string]>,
  rotation = 0,
): void {
  g.save();
  g.translate(cx, cy);
  g.rotate(rotation);
  g.scale(1, ry / rx);
  const grad = g.createRadialGradient(0, 0, 0, 0, 0, rx);
  for (const [at, col] of stops) grad.addColorStop(at, col);
  g.fillStyle = grad;
  g.beginPath();
  g.arc(0, 0, rx, 0, Math.PI * 2);
  g.fill();
  g.restore();
}

let softGlowTex: CanvasTexture | null = null;
let eyeGlowTex: CanvasTexture | null = null;

/** Soft round white blob (halos, breath on glass, light pools). */
export function softGlowTexture(): CanvasTexture {
  softGlowTex ??= canvasTexture(64, 64, (g, w, h) => {
    fillEllipseGradient(g, w / 2, h / 2, w / 2, h / 2, [
      [0, 'rgba(255,255,255,1)'],
      [0.35, 'rgba(255,255,255,0.55)'],
      [0.7, 'rgba(255,255,255,0.15)'],
      [1, 'rgba(255,255,255,0)'],
    ]);
  });
  return softGlowTex;
}

/**
 * One eye (2:1): a small hot almond core inside a faint halo, so a tiny quad
 * still reads from across a dark room. Tint with the material colour.
 */
export function eyeGlowTexture(): CanvasTexture {
  eyeGlowTex ??= canvasTexture(64, 32, (g, w, h) => {
    // Faint halo.
    fillEllipseGradient(g, w / 2, h / 2, w / 2, h / 2, [
      [0, 'rgba(255,255,245,0.55)'],
      [0.45, 'rgba(230,226,200,0.18)'],
      [1, 'rgba(0,0,0,0)'],
    ]);
    // Hot almond core.
    fillEllipseGradient(g, w / 2, h / 2, w * 0.2, h * 0.17, [
      [0, 'rgba(255,255,250,1)'],
      [0.55, 'rgba(250,248,230,0.95)'],
      [1, 'rgba(240,236,210,0)'],
    ]);
  });
  return eyeGlowTex;
}

// ─── Glowing eyes ─────────────────────────────────────────────────────────

export interface EyesOptions {
  /** Distance between the two eye centres (m). */
  spacing: number;
  /** Width of one eye quad including its halo (m). Height is half of it. */
  size: number;
  color?: number;
  renderOrder?: number;
}

const BLINK_SEC = 0.13;

/**
 * Two small additive glowing eyes. Position/aim `group`, then call
 * `set(intensity, squint)` and `update(dt)` each frame. They blink on their own.
 */
export class GlowingEyes {
  readonly group = new Group();
  readonly material: MeshBasicMaterial;
  private readonly left: Mesh;
  private readonly right: Mesh;
  private readonly height: number;
  private intensity = 0;
  private squint = 1;
  private blinkLeft = 0;
  private nextBlinkIn = randRange(1.5, 5);

  constructor(o: EyesOptions) {
    this.material = new MeshBasicMaterial({
      map: eyeGlowTexture(),
      color: o.color ?? PALETTE.sickly,
      transparent: true,
      opacity: 0,
      blending: AdditiveBlending,
      depthWrite: false,
    });
    this.height = o.size * 0.5;
    const geo = unitPlane();
    this.left = new Mesh(geo, this.material);
    this.right = new Mesh(geo, this.material);
    this.left.position.x = -o.spacing / 2;
    this.right.position.x = o.spacing / 2;
    // Inner corners slightly lower: patient, predatory.
    this.left.rotation.z = -0.14;
    this.right.rotation.z = 0.14;
    for (const m of [this.left, this.right]) {
      m.scale.set(o.size, this.height, 1);
      m.renderOrder = o.renderOrder ?? RENDER_ORDER.glow;
      this.group.add(m);
    }
  }

  /** intensity 0..1+ (opacity), squint 1 = open .. ~0.15 = narrowed slits. */
  set(intensity: number, squint = 1): void {
    this.intensity = intensity;
    this.squint = squint;
  }

  /** Force a blink now (e.g. the moment it is countered). */
  blink(): void {
    this.blinkLeft = BLINK_SEC;
  }

  update(dt: number): void {
    if (this.blinkLeft > 0) {
      this.blinkLeft -= dt;
    } else if ((this.nextBlinkIn -= dt) <= 0) {
      this.blinkLeft = BLINK_SEC;
      this.nextBlinkIn = randRange(2.5, 7);
    }
    const lid = this.blinkLeft > 0 ? 0.06 : 1;
    const sy = this.height * Math.max(0.04, this.squint * lid);
    this.left.scale.y = sy;
    this.right.scale.y = sy;
    this.material.opacity = Math.max(0, this.intensity);
  }
}

// ─── Audio slots ──────────────────────────────────────────────────────────

/** Ramp a gain to 0 over `fadeSec` (no click); returns the fade actually used. */
function fadeGainOut(gain: GainNode, fadeSec: number): number {
  const fade = Math.max(0.01, fadeSec);
  try {
    const now = gain.context.currentTime;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(gain.gain.value, now);
    gain.gain.linearRampToValueAtTime(0, now + fade);
  } catch {
    /* context closed */
  }
  return fade;
}

function disconnectQuietly(node: AudioNode | null): void {
  try {
    node?.disconnect();
  } catch {
    /* already gone */
  }
}

/**
 * One spatial voice plus a private gain in front of it, so it can be faded
 * out (no click) and is always disposed. Connect one-shots (retreat sounds)
 * to `input` and the threat's warning loops to `loopInput`, which sits behind
 * a counter duck (`setDuck`) so the warning can drop well below its plain
 * level while the player is countering, without touching the one-shots.
 */
export class VoiceSlot {
  private voice: SpatialVoice | null = null;
  private gain: GainNode | null = null;
  private duck: GainNode | null = null;
  private duckLevel = 1;

  get input(): AudioNode | null {
    return this.gain;
  }

  /** Input for warning loops: feeds `input` through the counter duck. */
  get loopInput(): AudioNode | null {
    return this.duck;
  }

  get open(): boolean {
    return this.voice !== null;
  }

  /** Release any current voice, then open a new one (duck at 1). Returns the input node. */
  openAt(audio: AudioEngineLike, position: Vector3, bus: 'game' | 'over', refDistance?: number): AudioNode | null {
    this.release(0.05);
    try {
      const voice = audio.createVoice(position, bus, refDistance);
      const gain = audio.ctx.createGain();
      gain.gain.value = 1;
      gain.connect(voice.input);
      const duck = audio.ctx.createGain();
      duck.gain.value = 1;
      duck.connect(gain);
      this.voice = voice;
      this.gain = gain;
      this.duck = duck;
      this.duckLevel = 1;
    } catch (err) {
      console.warn('[threats] could not open a voice', err);
      this.voice = null;
      this.gain = null;
      this.duck = null;
    }
    return this.gain;
  }

  setPosition(p: Vector3): void {
    this.voice?.setPosition(p);
  }

  /**
   * Glide the loop duck toward `level` (1 = plain warning level) with time
   * constant `tcSec`. Only schedules when the target actually changes, so it
   * is cheap to call every frame with a two-state target.
   */
  setDuck(level: number, tcSec: number): void {
    const duck = this.duck;
    if (!duck) return;
    const x = level < 0 ? 0 : level;
    if (Math.abs(x - this.duckLevel) < 0.005) return;
    this.duckLevel = x;
    try {
      duck.gain.setTargetAtTime(x, duck.context.currentTime, Math.max(0.005, tcSec));
    } catch {
      /* context closed */
    }
  }

  /** Fade out over `fadeSec`, then disconnect and dispose. Safe to call twice. */
  release(fadeSec = 0.06): void {
    const voice = this.voice;
    const gain = this.gain;
    const duck = this.duck;
    this.voice = null;
    this.gain = null;
    this.duck = null;
    if (!voice || !gain) return;
    const fade = fadeGainOut(gain, fadeSec);
    setTimeout(() => {
      disconnectQuietly(duck);
      disconnectQuietly(gain);
      voice.dispose();
    }, (fade + 0.05) * 1000);
  }
}

/**
 * A private, non-spatial gain on a bus, so a one-shot played into it can
 * still be cut off (reset) instead of running on unowned.
 */
export class BusSlot {
  private gain: GainNode | null = null;

  get input(): AudioNode | null {
    return this.gain;
  }

  /** Release any current gain, then open a new one on `bus`. Returns its input. */
  openOn(audio: AudioEngineLike, bus: 'game' | 'over'): AudioNode | null {
    this.release(0.05);
    try {
      const gain = audio.ctx.createGain();
      gain.gain.value = 1;
      gain.connect(bus === 'over' ? audio.overBus : audio.gameBus);
      this.gain = gain;
    } catch (err) {
      console.warn('[threats] could not open a bus slot', err);
      this.gain = null;
    }
    return this.gain;
  }

  /** Fade out over `fadeSec`, then disconnect. Safe to call twice. */
  release(fadeSec = 0.06): void {
    const gain = this.gain;
    this.gain = null;
    if (!gain) return;
    const fade = fadeGainOut(gain, fadeSec);
    setTimeout(() => disconnectQuietly(gain), (fade + 0.05) * 1000);
  }
}

/** A loop handle that only forwards meaningful intensity changes. */
export class LoopSlot {
  private handle: LoopHandle | null = null;
  private last = -1;

  get running(): boolean {
    return this.handle !== null;
  }

  start(handle: LoopHandle, intensity = 0): void {
    this.stop(0.05);
    this.handle = handle;
    this.last = -1;
    this.set(intensity);
  }

  set(intensity: number): void {
    const h = this.handle;
    if (!h) return;
    const x = clamp01(intensity);
    const d = x - this.last;
    if (d < 0.01 && d > -0.01 && !((x === 0 || x === 1) && x !== this.last)) return;
    this.last = x;
    h.setIntensity(x);
  }

  stop(fadeSec?: number): void {
    const h = this.handle;
    this.handle = null;
    if (h) h.stop(fadeSec);
  }
}
