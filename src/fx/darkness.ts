import { BackSide, Color, Mesh, ShaderMaterial, SphereGeometry, type Vector3, type World } from '@iwsdk/core';
import { CONFIG } from '../config.js';
import type { DarknessLike } from '../game/contracts.js';

/** Near-black blue-grey at eye level, a touch darker and colder overhead. */
const COLOR_LOW = new Color('#0a0d12');
const COLOR_TOP = new Color('#05070a');

/** Below this delta / duration a fade is a plain cut (no dying-bulb flicker). */
const FLICKER_MIN_DELTA = 0.3;
const FLICKER_MIN_SEC = 1;
/** The two dips inside the flicker window: centre and half-width (fractions of the window), height (fraction of the fade). */
const DIPS = [
  { c: 0.18, w: 0.1, h: 0.8 },
  { c: 0.56, w: 0.14, h: 0.6 },
] as const;
/** Breathing periods (s): two incommensurate sines so it never feels mechanical. */
const BREATH_A = (2 * Math.PI) / 6.3;
const BREATH_B = (2 * Math.PI) / 2.9;
const HIDDEN_BELOW = 0.002;

const VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const FRAG = /* glsl */ `
uniform vec3 uColorLow;
uniform vec3 uColorTop;
uniform float uOpacity;
uniform float uTime;
uniform float uGrain;
varying vec3 vDir;

float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}

void main() {
  vec3 d = normalize(vDir);
  float up = smoothstep(-0.2, 1.0, d.y);
  vec3 col = mix(uColorLow, uColorTop, up);
  float a = uOpacity * mix(0.975, 1.03, up);
  // Film grain hashed on the view direction (both eyes agree, so it never shimmers
  // in stereo), re-rolled ~24 times a second like film.
  float frame = mod(floor(uTime * 24.0), 61.0);
  float g = hash13(floor(d * 700.0) + frame * 7.13) - 0.5;
  a = clamp(a + g * uGrain * uOpacity, 0.0, 1.0);
  col = max(col + g * uGrain * 0.15, 0.0);
  gl_FragColor = vec4(col, a);
  #include <colorspace_fragment>
}`;

const smooth01 = (x: number): number => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

/**
 * The dark room: a back-side shell around the head that dims passthrough
 * (WebXR can't dim it directly). Drawn before everything else (renderOrder
 * -1000, no depth write) so IWSDK's outline hands, monsters and the beam all
 * render over it.
 */
export class Darkness implements DarknessLike {
  private readonly mesh: Mesh;
  private readonly material: ShaderMaterial;
  private from = 0;
  private to = 0;
  private durSec = 0;
  private elapsedSec = 0;
  private current = 0;
  private flicker = false;
  private time = 0;
  /** 0..1, eases in once a fade has settled. */
  private breath = 0;

  constructor(world: World) {
    this.material = new ShaderMaterial({
      uniforms: {
        uColorLow: { value: COLOR_LOW },
        uColorTop: { value: COLOR_TOP },
        uOpacity: { value: 0 },
        uTime: { value: 0 },
        uGrain: { value: CONFIG.darkness.grain },
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      side: BackSide,
      transparent: true,
      depthWrite: false,
      depthTest: true,
    });
    this.mesh = new Mesh(new SphereGeometry(CONFIG.darkness.radiusM, 32, 16), this.material);
    this.mesh.name = 'darkness';
    this.mesh.renderOrder = -1000;
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    world.createTransformEntity(this.mesh, { persistent: true });
  }

  get opacity(): number {
    return this.current;
  }

  fadeTo(opacity: number, sec: number): void {
    const to = Math.min(1, Math.max(0, opacity));
    this.from = this.current;
    this.to = to;
    this.durSec = Math.max(0, sec);
    this.elapsedSec = 0;
    this.flicker = to - this.current >= FLICKER_MIN_DELTA && sec >= FLICKER_MIN_SEC;
    // Near-instant fades apply now: update() may not run again (e.g. after the session ends).
    if (this.durSec < 1 / 120) {
      this.durSec = 0;
      this.current = to;
      this.breath = 0;
      this.apply(to);
    }
  }

  update(dt: number, headPos: Vector3): void {
    this.time += dt;
    this.mesh.position.copy(headPos);

    let shown: number;
    const fading = this.elapsedSec < this.durSec;
    if (fading) {
      this.elapsedSec = Math.min(this.durSec, this.elapsedSec + dt);
      const p = this.elapsedSec / this.durSec;
      this.current = this.from + (this.to - this.from) * smooth01(p);
      shown = this.flicker ? Math.max(this.current, this.flickerLevel(p)) : this.current;
    } else {
      this.current = this.to;
      shown = this.current;
    }

    // Barely-there breathing once the room has settled into full dark.
    this.breath += ((fading ? 0 : 1) - this.breath) * (1 - Math.exp(-dt / 1.5));
    const dark = smooth01((shown - 0.6) / 0.3);
    const wave = 0.7 * Math.sin(this.time * BREATH_A) + 0.3 * Math.sin(this.time * BREATH_B + 1.7);
    shown *= 1 + CONFIG.darkness.breathAmplitude * this.breath * dark * wave;

    this.apply(shown);
  }

  /** Dying-bulb flicker: two quick drops of the light (darkness spikes) early in a fade-in. */
  private flickerLevel(p: number): number {
    const win = CONFIG.darkness.flickerFraction;
    if (p >= win) return 0;
    const x = p / win;
    let level = 0;
    for (const dip of DIPS) {
      const t = 1 - Math.abs(x - dip.c) / dip.w;
      if (t > 0) level = Math.max(level, dip.h * smooth01(t / 0.3));
    }
    return this.from + (this.to - this.from) * level;
  }

  private apply(shown: number): void {
    const u = this.material.uniforms;
    u.uOpacity.value = Math.min(1, Math.max(0, shown));
    u.uTime.value = this.time;
    this.mesh.visible = shown > HIDDEN_BELOW || this.to > HIDDEN_BELOW;
  }
}
