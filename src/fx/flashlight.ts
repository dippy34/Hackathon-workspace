import {
  AddEquation,
  AdditiveBlending,
  BackSide,
  CanvasTexture,
  Color,
  ConeGeometry,
  CustomBlending,
  Group,
  IcosahedronGeometry,
  Mesh,
  MeshBasicMaterial,
  OneFactor,
  Quaternion,
  ShaderMaterial,
  SpotLight,
  Sprite,
  SpriteMaterial,
  Vector3,
  ZeroFactor,
  type World,
} from '@iwsdk/core';
import { CONFIG } from '../config.js';
import type { AudioEngineLike, FlashlightLike, HandState, HandsState, Side } from '../game/contracts.js';

const DEG = Math.PI / 180;
const FORWARD = new Vector3(0, 0, -1);
/** Warm, slightly tired incandescent white. */
const LIGHT_COLOR = new Color('#ffe2b0');
/** Battery bead: pale sickly green (full) -> amber -> red (empty). */
const BEAD_FULL = new Color('#b9dcae');
const BEAD_MID = new Color('#ffb24d');
const BEAD_EMPTY = new Color('#ff3b26');
/** Bead sits just past the fingertips along the aim, so the hand's depth fill doesn't hide it. */
const BEAD_AHEAD_M = 0.014;
const BEAD_RADIUS_M = 0.0032;
const BEAD_HALO_M = 0.032;

const CONE_VERT = /* glsl */ `
varying vec3 vLocal;
varying vec3 vEyeLocal;
varying vec3 vWorld;
varying vec3 vEyeWorld;
void main() {
  vec4 world = modelMatrix * vec4(position, 1.0);
  // Per-view eye position (viewMatrix is per eye under multiview).
  vec3 eye = -transpose(mat3(viewMatrix)) * viewMatrix[3].xyz;
  vLocal = position;
  vWorld = world.xyz;
  vEyeWorld = eye;
  vEyeLocal = transpose(mat3(modelMatrix)) * (eye - modelMatrix[3].xyz); // rigid transform
  gl_Position = projectionMatrix * viewMatrix * world;
}`;

/**
 * Volumetric-looking beam: for each back-face (exit) fragment, intersect the
 * view ray with the analytic cone (apex at the origin, axis -Z) to find where
 * it entered, then integrate a soft density along that chord. Looks right
 * from the side and from behind the hand (where a fresnel cone would vanish).
 */
const CONE_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uGlow;
uniform float uTanHalf;
uniform float uLength;
uniform float uTime;
varying vec3 vLocal;
varying vec3 vEyeLocal;
varying vec3 vWorld;
varying vec3 vEyeWorld;
const mat3 DUST_ROT = mat3(0.80, 0.36, -0.48, -0.60, 0.48, -0.64, 0.0, 0.80, 0.60);

float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.zyx + 31.32);
  return fract((p.x + p.y) * p.z);
}
float vnoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(
    mix(mix(hash13(i), hash13(i + vec3(1, 0, 0)), f.x), mix(hash13(i + vec3(0, 1, 0)), hash13(i + vec3(1, 1, 0)), f.x), f.y),
    mix(mix(hash13(i + vec3(0, 0, 1)), hash13(i + vec3(1, 0, 1)), f.x), mix(hash13(i + vec3(0, 1, 1)), hash13(i + vec3(1, 1, 1)), f.x), f.y),
    f.z);
}
float density(vec3 q) {
  float z = -q.z;
  if (z <= 0.0) return 0.0;
  float r = length(q.xy) / (uTanHalf * z);
  float radial = clamp(1.0 - r * r, 0.0, 1.0);
  radial *= radial;
  // Light spreads over an area ~z^2; fade in off the fingertips, out at the far end.
  float axial = 1.0 / (1.0 + z * z * 4.0);
  axial *= smoothstep(0.0, 0.12, z) * (1.0 - smoothstep(uLength * 0.6, uLength, z));
  return radial * axial;
}

void main() {
  vec3 o = vEyeLocal;
  vec3 toP = vLocal - o;
  float tExit = length(toP);
  vec3 d = toP / tExit;
  float k = uTanHalf * uTanHalf;
  float tIn = tExit;
  float c = o.x * o.x + o.y * o.y - k * o.z * o.z;
  if (c < 0.0 && o.z < 0.0) {
    tIn = 0.0; // eye inside the beam
  } else {
    float a = d.x * d.x + d.y * d.y - k * d.z * d.z;
    float b = 2.0 * (o.x * d.x + o.y * d.y - k * o.z * d.z);
    float disc = b * b - 4.0 * a * c;
    if (disc > 0.0 && abs(a) > 1e-6) {
      float s = sqrt(disc);
      float t1 = (-b - s) / (2.0 * a);
      float t2 = (-b + s) / (2.0 * a);
      float lim = tExit * 0.995 - 0.002;
      if (t1 < lim && o.z + t1 * d.z < 0.0) tIn = min(tIn, max(t1, 0.0));
      if (t2 < lim && o.z + t2 * d.z < 0.0) tIn = min(tIn, max(t2, 0.0));
    }
  }
  float chord = tExit - tIn;
  if (chord < 1e-4) discard;

  // Samples bunched toward the entry (usually nearer the bright apex).
  float sum = 0.0;
  for (int i = 0; i < 5; i++) {
    float f = (float(i) + 0.5) / 5.0;
    sum += density(o + d * (tIn + chord * f * f)) * f;
  }
  float lum = sum * 0.4 * chord * uGlow;

  // Faint world-anchored dust shimmer drifting through the beam (rotated domain hides the noise grid).
  vec3 qw = DUST_ROT * (vEyeWorld + normalize(vWorld - vEyeWorld) * (tIn + chord * 0.3));
  float dust = 0.86 + 0.28 * vnoise(qw * 2.5 + vec3(0.0, uTime * 0.06, uTime * 0.025));
  gl_FragColor = vec4(uColor * lum * dust, 0.0);
  #include <colorspace_fragment>
}`;

/** Soft round glow for the battery bead's halo (made once, 64 px). */
function makeHaloTexture(): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.25, 'rgba(255,255,255,0.45)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new CanvasTexture(c);
}

/**
 * The flashlight (DESIGN.md Peeker): on while a hand pinches during a night,
 * battery permitting. Owns the game's only real-time light, a cheap
 * volumetric beam and the battery bead (the only UI during nights).
 */
export class Flashlight implements FlashlightLike {
  readonly origin = new Vector3();
  readonly direction = new Vector3(0, 0, -1);

  private _on = false;
  private _battery = 1;
  private allowed = false;
  /** Hand that owns the pinch (even while the light can't be on). */
  private holder: Side | null = null;
  private emptyPlayed = false;
  private time = 0;
  private readonly cosHalf = Math.cos(CONFIG.flashlight.beamHalfAngleDeg * DEG);

  // Low-battery stutter state.
  private stutterWait = 0;
  private stutterLeft = 0;
  private stutterLevel = 1;

  private readonly rig = new Group();
  private readonly light: SpotLight;
  private readonly cone: Mesh;
  private readonly coneMat: ShaderMaterial;
  private readonly bead = new Group();
  private readonly beadMat: MeshBasicMaterial;
  private readonly haloMat: SpriteMaterial;
  private readonly beadColor = new Color();
  private readonly tmp = new Vector3();
  private readonly tmpQ = new Quaternion();

  constructor(world: World) {
    const halfVisual = CONFIG.flashlight.beamHalfAngleDeg * CONFIG.flashlight.visualAngleScale * DEG;
    const range = CONFIG.flashlight.beamRangeM;

    // The light stays visible with intensity 0 when off: toggling visibility changes
    // the scene's light count and recompiles every lit material (a hitch).
    this.light = new SpotLight(LIGHT_COLOR, 0, range, halfVisual, 0.6, 2);
    this.light.castShadow = false;
    this.rig.add(this.light, this.light.target);
    this.light.target.position.copy(FORWARD);

    const geo = new ConeGeometry(Math.tan(halfVisual) * range, range, 32, 1, false);
    geo.translate(0, -range / 2, 0).rotateX(Math.PI / 2); // apex at origin, opening toward -Z
    this.coneMat = new ShaderMaterial({
      uniforms: {
        uColor: { value: LIGHT_COLOR },
        uGlow: { value: 0 },
        uTanHalf: { value: Math.tan(halfVisual) },
        uLength: { value: range },
        uTime: { value: 0 },
      },
      vertexShader: CONE_VERT,
      fragmentShader: CONE_FRAG,
      side: BackSide,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      // Add light without touching alpha: brightens, never occludes passthrough.
      blending: CustomBlending,
      blendEquation: AddEquation,
      blendSrc: OneFactor,
      blendDst: OneFactor,
      blendSrcAlpha: ZeroFactor,
      blendDstAlpha: OneFactor,
    });
    this.cone = new Mesh(geo, this.coneMat);
    this.cone.name = 'flashlight-beam';
    this.cone.renderOrder = 5;
    this.cone.frustumCulled = false;
    this.cone.visible = false;
    this.rig.add(this.cone);
    this.rig.name = 'flashlight';
    world.createTransformEntity(this.rig, { persistent: true });

    this.beadMat = new MeshBasicMaterial({ color: BEAD_FULL, toneMapped: false, transparent: true });
    const core = new Mesh(new IcosahedronGeometry(BEAD_RADIUS_M, 1), this.beadMat);
    core.renderOrder = 6;
    this.haloMat = new SpriteMaterial({
      map: makeHaloTexture(),
      color: BEAD_FULL,
      blending: AdditiveBlending,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
    });
    const halo = new Sprite(this.haloMat);
    halo.scale.setScalar(BEAD_HALO_M);
    halo.renderOrder = 6;
    this.bead.add(core, halo);
    this.bead.name = 'flashlight-battery';
    this.bead.visible = false;
    world.createTransformEntity(this.bead, { persistent: true });
  }

  get on(): boolean {
    return this._on;
  }

  get battery(): number {
    return this._battery;
  }

  get hand(): Side | null {
    return this._on ? this.holder : null;
  }

  containsPoint(p: Vector3): boolean {
    if (!this._on) return false;
    const v = this.tmp.subVectors(p, this.origin);
    const dist = v.length();
    if (dist > CONFIG.flashlight.beamRangeM) return false;
    if (dist < 1e-4) return true;
    return v.dot(this.direction) / dist >= this.cosHalf;
  }

  setAllowed(allowed: boolean): void {
    this.allowed = allowed;
    if (!allowed && this._on) {
      // Silent: this happens on phase changes (caught, dawn), not by the player's hand.
      this._on = false;
      this.hideVisuals();
    }
  }

  refill(): void {
    this._battery = 1;
  }

  update(dt: number, hands: HandsState, audio: AudioEngineLike): void {
    this.time += dt;
    this.updateHolder(hands);

    const wantOn = this.allowed && this.holder !== null;
    let on = wantOn && this._battery > 0;
    if (on) {
      this._battery = Math.max(0, this._battery - dt / CONFIG.flashlight.batterySec);
      if (this._battery <= 0) on = false;
    }

    const sounds = audio.sounds;
    if (wantOn && !on) {
      // Dead battery (or it just died in the hand): one dry click per pinch.
      if (!this.emptyPlayed) sounds.oneShot('flashEmpty', audio.gameBus);
      this.emptyPlayed = true;
    } else if (on && !this._on) {
      sounds.oneShot('flashOn', audio.gameBus);
    } else if (!on && this._on && this.allowed) {
      sounds.oneShot('flashOff', audio.gameBus);
    }

    const justOn = on && !this._on;
    this._on = on;
    if (!on || this.holder === null) {
      this.hideVisuals();
      return;
    }

    const h = hands[this.holder];
    this.followAim(h, dt, justOn);
    this.updateVisuals(h, dt);
  }

  /** First hand to pinch keeps the light until it lets go; then the other hand may take over. */
  private updateHolder(hands: HandsState): void {
    if (this.holder && !hands[this.holder].pinching) {
      const other: Side = this.holder === 'left' ? 'right' : 'left';
      this.holder = hands[other].pinching ? other : null;
    }
    if (!this.holder) {
      if (hands.right.pinching) this.holder = 'right';
      else if (hands.left.pinching) this.holder = 'left';
    }
    if (!this.holder) this.emptyPlayed = false;
  }

  /** ~40 ms exponential smoothing of the aim ray (kills tracking jitter). */
  private followAim(h: HandState, dt: number, snap: boolean): void {
    const k = snap ? 1 : 1 - Math.exp(-dt / CONFIG.flashlight.smoothingSec);
    this.origin.lerp(h.aimOrigin, k);
    this.direction.lerp(h.aimDir, k);
    if (this.direction.lengthSq() < 1e-8) this.direction.copy(h.aimDir);
    this.direction.normalize();
  }

  private updateVisuals(h: HandState, dt: number): void {
    const b = this._battery;
    const lowFrac = CONFIG.flashlight.lowBatteryFraction;
    const lowness = b < lowFrac ? 1 - b / lowFrac : 0;
    const stutter = this.stutter(dt, lowness);
    const level = stutter * (1 - CONFIG.flashlight.lowBatteryDim * lowness);

    this.rig.position.copy(this.origin);
    this.rig.quaternion.copy(this.tmpQ.setFromUnitVectors(FORWARD, this.direction));
    this.light.intensity = CONFIG.flashlight.lightIntensity * level;
    const u = this.coneMat.uniforms;
    u.uGlow.value = CONFIG.flashlight.beamGlow * level;
    u.uTime.value = this.time;
    this.cone.visible = true;

    // Battery bead: colour tracks charge; below the low mark it pulses faster as it empties.
    if (b > 0.5) this.beadColor.lerpColors(BEAD_MID, BEAD_FULL, (b - 0.5) / 0.5);
    else this.beadColor.lerpColors(BEAD_EMPTY, BEAD_MID, b / 0.5);
    let glow = 1;
    if (lowness > 0) {
      const pulse = 0.5 + 0.5 * Math.sin(this.time * (5 + 9 * lowness) * Math.PI);
      glow = (0.35 + 0.65 * pulse) * (stutter < 1 ? 0.3 : 1);
    }
    this.beadMat.color.copy(this.beadColor);
    this.beadMat.opacity = 0.55 + 0.45 * glow;
    this.haloMat.color.copy(this.beadColor);
    this.haloMat.opacity = 0.6 * glow;
    this.bead.position.copy(h.pinchPoint).addScaledVector(h.aimDir, BEAD_AHEAD_M);
    this.bead.visible = true;
  }

  /** Low-battery stutter: random short drops in output, more often as the battery empties. */
  private stutter(dt: number, lowness: number): number {
    if (lowness <= 0) {
      this.stutterLeft = 0;
      return 1;
    }
    if (this.stutterLeft > 0) {
      this.stutterLeft -= dt;
      return this.stutterLevel;
    }
    this.stutterWait -= dt;
    if (this.stutterWait <= 0) {
      this.stutterWait = 0.08 + Math.random() * 0.6 * (1.2 - lowness);
      if (Math.random() < 0.2 + 0.6 * lowness) {
        this.stutterLeft = 0.03 + Math.random() * 0.09;
        this.stutterLevel = 0.12 + Math.random() * 0.45;
      }
    }
    return 1;
  }

  private hideVisuals(): void {
    this.light.intensity = 0;
    this.cone.visible = false;
    this.bead.visible = false;
  }
}
