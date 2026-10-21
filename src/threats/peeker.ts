/**
 * The Peeker (DESIGN.md). Counter (LOCKED): flashlight on, beam on the face.
 *
 * Warning: tapping on the glass of one of the player's real windows, and a
 * pale, too-smooth oval face with dark hollow eyes fading in OUTSIDE it. As
 * the meter rises the face slowly comes through the glass into the room
 * (startOutsideM outside → fullInsideM inside at a full meter). It always
 * stares at the player and tilts its head a little.
 * Lit: it brightens (fake flashlight lighting), flinches, squints and recoils;
 * the taps all but stop (their loop is ducked to threatFx.counterDuck).
 * Leave: it pulls back outside and fades, glassRetreat.
 * Caught: it rushes at the player's head (~0.4 s), mouth open, faceRush on the
 * over-bus.
 *
 * Three meshes in total: the face (a slightly curved low-poly cap with a
 * canvas texture), and a faint breath-on-glass haze at the window plane.
 */

import {
  AdditiveBlending,
  Group,
  Mesh,
  MeshBasicMaterial,
  SphereGeometry,
  Vector3,
  type CanvasTexture,
  type World,
} from '@iwsdk/core';
import { CONFIG } from '../config.js';
import type { AttackView } from '../core/types.js';
import type { FrameContext, RoomFeature, ThreatPresenter } from '../game/contracts.js';
import {
  LoopSlot,
  PALETTE,
  RENDER_ORDER,
  VoiceSlot,
  canvasTexture,
  clamp,
  clamp01,
  damp,
  easeInOutSine,
  fillEllipseGradient,
  jitter,
  lerp,
  orientToForward,
  pickRandom,
  pointInFrontOfHead,
  randRange,
  smoothstep,
  softGlowTexture,
  unitPlane,
  wobble,
} from './common.js';

const FX = CONFIG.threatFx.peeker;

type Mode = 'idle' | 'active' | 'leaving' | 'caught';
type FaceVariant = 'calm' | 'squint' | 'rush';

/** Face size: a little larger than a person's, which is part of what is wrong with it. */
const FACE_SCALE_X = 0.1;
const FACE_SCALE_Y = 0.135;
const FACE_SCALE_Z = 0.075;

/** A pale, too-smooth oval: hollow eyes, almost no nose, a thin mouth. */
function faceTexture(variant: FaceVariant): CanvasTexture {
  return canvasTexture(256, 256, (g, w, h) => {
    fillEllipseGradient(g, w * 0.5, h * 0.5, w * 0.46, h * 0.48, [
      [0, 'rgba(240,236,226,1)'],
      [0.5, 'rgba(226,221,208,1)'],
      [0.78, 'rgba(184,182,174,0.92)'],
      [0.92, 'rgba(118,126,134,0.45)'],
      [1, 'rgba(90,100,110,0)'],
    ]);
    // Features only ever darken the skin, never spill past it.
    g.globalCompositeOperation = 'source-atop';

    // Faint hollows under the cheekbones.
    for (const side of [-1, 1]) {
      fillEllipseGradient(g, w * (0.5 + side * 0.2), h * 0.6, w * 0.09, h * 0.12, [
        [0, 'rgba(70,72,76,0.16)'],
        [1, 'rgba(70,72,76,0)'],
      ]);
    }

    const eyeY = h * (variant === 'squint' ? 0.44 : 0.43);
    for (const side of [-1, 1]) {
      const cx = w * 0.5 + side * w * 0.135;
      let rx = w * 0.085;
      let ry = h * 0.058;
      let rot = side * -0.1;
      if (variant === 'squint') {
        rx = w * 0.08;
        ry = h * 0.017;
        rot = side * 0.22;
      } else if (variant === 'rush') {
        rx = w * 0.096;
        ry = h * 0.088;
        rot = 0;
      }
      // Sunken socket, then the hollow itself.
      fillEllipseGradient(g, cx, eyeY + h * 0.01, rx * 1.6, ry * 1.9 + h * 0.02, [
        [0, 'rgba(56,58,62,0.38)'],
        [1, 'rgba(56,58,62,0)'],
      ], rot);
      fillEllipseGradient(g, cx, eyeY, rx, ry, [
        [0, 'rgba(0,0,0,1)'],
        [0.6, 'rgba(4,4,6,0.97)'],
        [0.86, 'rgba(22,22,26,0.6)'],
        [1, 'rgba(40,40,46,0)'],
      ], rot);
      if (variant === 'squint') {
        // Brow pinched down hard.
        fillEllipseGradient(g, cx - side * w * 0.01, eyeY - h * 0.055, w * 0.075, h * 0.009, [
          [0, 'rgba(60,60,66,0.45)'],
          [1, 'rgba(60,60,66,0)'],
        ], side * 0.28);
      }
    }

    // Barely a nose.
    for (const side of [-1, 1]) {
      fillEllipseGradient(g, w * (0.5 + side * 0.028), h * 0.6, w * 0.014, h * 0.01, [
        [0, 'rgba(40,40,44,0.32)'],
        [1, 'rgba(40,40,44,0)'],
      ]);
    }

    if (variant === 'rush') {
      fillEllipseGradient(g, w * 0.5, h * 0.755, w * 0.075, h * 0.125, [
        [0, 'rgba(0,0,0,1)'],
        [0.7, 'rgba(6,5,6,0.95)'],
        [1, 'rgba(30,28,30,0)'],
      ]);
    } else {
      const squint = variant === 'squint';
      fillEllipseGradient(g, w * 0.5, h * 0.72, w * (squint ? 0.07 : 0.1), h * (squint ? 0.006 : 0.009), [
        [0, `rgba(28,24,24,${squint ? 0.85 : 0.72})`],
        [1, 'rgba(28,24,24,0)'],
      ]);
    }
    g.globalCompositeOperation = 'source-over';
  });
}

export class PeekerThreat implements ThreatPresenter {
  readonly id = 'peeker' as const;
  readonly teachingHint = 'Pinch. Light it.';

  private root!: Group;
  private face!: Mesh;
  private faceMat!: MeshBasicMaterial;
  private smear!: Mesh;
  private smearMat!: MeshBasicMaterial;
  private maps!: Record<FaceVariant, CanvasTexture>;
  private variant: FaceVariant = 'calm';

  private readonly taps = new LoopSlot();
  private readonly voice = new VoiceSlot();
  private readonly overVoice = new VoiceSlot();

  private mode: Mode = 'idle';
  private hasFrame = false;
  private meter = 0;
  private countering = false;
  private teaching = false;

  private time = 0;
  private modeT = 0;
  private lingerLeft = 0;
  private lat = 0;
  private vert = 0;
  private fadeIn = 0;
  private mSm = 0;
  private lit = 0;
  private flinch = 0;
  private recoil = 0;
  private smearAmt = 0;
  private opacity = 0;
  private startDepth = 0;
  private startOpacity = 0;

  /** Current face centre (world). The beam test uses it. */
  private readonly facePos = new Vector3();
  private readonly voicePos = new Vector3();
  private readonly rushStart = new Vector3();
  private readonly tmpA = new Vector3();
  private readonly tmpB = new Vector3();

  init(world: World): void {
    this.root = new Group();
    this.root.name = 'threat-peeker';
    world.createTransformEntity(this.root, { persistent: true });
    this.root.visible = false;

    this.maps = { calm: faceTexture('calm'), squint: faceTexture('squint'), rush: faceTexture('rush') };
    // A shallow cap of a sphere, squashed into an oval: a face, not a plate.
    const geo = new SphereGeometry(1, 16, 12, Math.PI / 2 - 0.95, 1.9, Math.PI / 2 - 1.05, 2.1);
    this.faceMat = new MeshBasicMaterial({
      map: this.maps.calm,
      transparent: true,
      opacity: 0,
      depthWrite: true,
      alphaTest: 0.03,
    });
    this.face = new Mesh(geo, this.faceMat);
    this.face.scale.set(FACE_SCALE_X, FACE_SCALE_Y, FACE_SCALE_Z);
    this.face.renderOrder = RENDER_ORDER.body;
    this.root.add(this.face);

    // Breath on the glass where the face presses through; drawn after the face so it hazes it from outside.
    this.smearMat = new MeshBasicMaterial({
      map: softGlowTexture(),
      color: PALETTE.glassBlue,
      transparent: true,
      opacity: 0,
      blending: AdditiveBlending,
      depthWrite: false,
    });
    this.smear = new Mesh(unitPlane(), this.smearMat);
    this.smear.scale.set(0.34, 0.42, 1);
    this.smear.renderOrder = RENDER_ORDER.body + 2;
    this.root.add(this.smear);
  }

  available(ctx: FrameContext): boolean {
    return ctx.room.windows.length > 0;
  }

  isCountering(ctx: FrameContext): boolean {
    return ctx.flashlight.on && ctx.flashlight.containsPoint(this.facePos);
  }

  begin(attack: AttackView, ctx: FrameContext): void {
    this.releaseAudio(0.05);
    const win = pickRandom(ctx.room.windows);
    this.placeFrame(ctx, win);
    const ww = win ? clamp(win.width, 0.3, 3) : 1;
    const wh = win ? clamp(win.height, 0.3, 2.5) : 1;
    const latRange = Math.max(0, ww / 2 - 0.16) * 0.6;
    const vRange = Math.max(0, wh / 2 - 0.18);
    this.lat = randRange(-latRange, latRange);
    this.vert = clamp(randRange(-0.05, 0.12), -vRange, vRange);

    this.fadeIn = 0;
    this.mSm = 0;
    this.lit = 0;
    this.flinch = 0;
    this.recoil = 0;
    this.smearAmt = 0;
    this.opacity = 0;
    this.modeT = 0;
    this.mode = 'active';
    this.sync(attack);
    this.setVariant('calm');
    this.faceMat.opacity = 0;
    this.smearMat.opacity = 0;
    this.smear.position.set(this.lat, this.vert, 0.004);
    this.placeFace(ctx, -FX.startOutsideM, 0, 1);
    this.root.visible = true;

    this.root.localToWorld(this.voicePos.set(this.lat, this.vert, 0));
    this.voice.openAt(ctx.audio, this.voicePos, 'game');
    const loopIn = this.voice.loopInput;
    if (loopIn) this.taps.start(ctx.audio.sounds.glassTaps(loopIn), 0.3);
  }

  update(attack: AttackView, _ctx: FrameContext): void {
    if (this.mode === 'active') this.sync(attack);
  }

  leave(ctx: FrameContext): void {
    if (this.mode !== 'active') return;
    this.mode = 'leaving';
    this.modeT = 0;
    this.startDepth = this.face.position.z;
    this.startOpacity = this.opacity;
    this.taps.stop(0.3);
    const input = this.voice.input;
    if (input) ctx.audio.sounds.oneShot('glassRetreat', input);
    this.lingerLeft = CONFIG.threatFx.voiceLingerSec;
  }

  caught(ctx: FrameContext): void {
    if (!this.hasFrame || this.mode === 'idle') {
      this.placeFrame(ctx, pickRandom(ctx.room.windows));
      this.placeFace(ctx, 0, 0, 1);
    }
    this.taps.stop(0.05);
    this.voice.release(0.08);
    this.lingerLeft = 0;
    this.rushStart.copy(this.face.position);
    this.mode = 'caught';
    this.modeT = 0;
    this.setVariant('rush');
    this.faceMat.opacity = 1;
    this.root.visible = true;
    const input = this.overVoice.openAt(ctx.audio, this.facePos, 'over', 0.4);
    if (input) ctx.audio.sounds.oneShot('faceRush', input, FX.faceRushGain);
  }

  tick(ctx: FrameContext): void {
    const dt = Math.min(ctx.dt, CONFIG.maxFrameSec);
    this.time += dt;
    if (this.lingerLeft > 0 && (this.lingerLeft -= dt) <= 0) this.voice.release(0.25);
    switch (this.mode) {
      case 'active':
        this.tickActive(ctx, dt);
        break;
      case 'leaving':
        this.tickLeaving(ctx, dt);
        break;
      case 'caught':
        this.tickCaught(ctx, dt);
        break;
      case 'idle':
        break;
    }
  }

  hintAnchor(ctx: FrameContext, out: Vector3): Vector3 {
    if (this.hasFrame) return this.root.localToWorld(out.set(this.lat, this.vert + 0.3, 0.25));
    return pointInFrontOfHead(ctx.headPos, ctx.headForward, 0.8, 0.15, out);
  }

  reset(): void {
    this.releaseAudio(0.05);
    this.hideVisuals();
  }

  // ─── Per-mode animation ────────────────────────────────────────────────

  private tickActive(ctx: FrameContext, dt: number): void {
    this.fadeIn = Math.min(1, this.fadeIn + dt / FX.fadeInSec);
    // The meter is the face's progress through the glass.
    this.mSm = damp(this.mSm, this.meter, 2.5, dt);
    const inBeam = ctx.flashlight.on && ctx.flashlight.containsPoint(this.facePos);
    this.lit = damp(this.lit, inBeam ? 1 : 0, 12, dt);
    this.flinch = damp(this.flinch, this.countering ? 1 : 0, 9, dt);
    this.recoil = damp(this.recoil, this.countering ? FX.flinchRecoilM : 0, 5, dt);

    const depth = lerp(-FX.startOutsideM, FX.fullInsideM, easeInOutSine(this.mSm)) - this.recoil;
    this.placeFace(ctx, depth, 0.001 + 0.007 * this.flinch, 1 - 0.06 * this.flinch);
    this.setVariant(this.flinch > 0.5 ? 'squint' : 'calm');

    // Behind the glass it is hazier; inside it is all there.
    const glass = lerp(0.6, 1, smoothstep(-0.2, 0.02, depth));
    this.opacity = this.fadeIn * glass;
    this.faceMat.opacity = this.opacity;
    const bright = lerp(FX.darkBrightness, FX.litBrightness, this.lit) * (0.9 + 0.2 * this.mSm);
    this.faceMat.color.setScalar(bright * (this.teaching ? 1.15 : 1));

    const crossing = 1 - smoothstep(0.02, 0.22, Math.abs(depth));
    this.smearAmt = damp(this.smearAmt, 0.13 * crossing + (depth > 0.05 ? 0.03 : 0), 4, dt);
    this.smearMat.opacity = this.smearAmt * this.fadeIn;

    // Tapping follows the meter; it all but stops while the light is on it.
    this.taps.set(lerp(0.3 + 0.7 * this.meter, 0.06, this.flinch));
    this.voice.setDuck(this.countering ? CONFIG.threatFx.counterDuck : 1, CONFIG.threatFx.counterDuckSec);
  }

  private tickLeaving(ctx: FrameContext, dt: number): void {
    this.modeT += dt;
    const t = clamp01(this.modeT / FX.retreatSec);
    const depth = lerp(this.startDepth, -(FX.startOutsideM + 0.3), easeInOutSine(t));
    this.flinch = damp(this.flinch, 0, 3, dt);
    this.placeFace(ctx, depth, 0.003 * (1 - t), 1 - 0.06 * this.flinch);
    if (t > 0.6) this.setVariant('calm');
    this.opacity = this.startOpacity * (1 - smoothstep(0.15, 1, t));
    this.faceMat.opacity = this.opacity;
    this.lit = damp(this.lit, 0, 4, dt);
    this.faceMat.color.setScalar(lerp(FX.darkBrightness, FX.litBrightness, this.lit));
    this.smearAmt = damp(this.smearAmt, 0, 3, dt);
    this.smearMat.opacity = this.smearAmt;
    if (t >= 1) this.hideVisuals();
  }

  private tickCaught(ctx: FrameContext, dt: number): void {
    this.modeT += dt;
    const u = this.modeT / FX.rushSec;
    const t = clamp01(u);
    const e = lerp(t, t * t, 0.6);
    pointInFrontOfHead(ctx.headPos, ctx.headForward, FX.rushFaceDistM, 0, this.tmpB);
    this.root.worldToLocal(this.tmpA.copy(this.tmpB));
    this.tmpA.lerpVectors(this.rushStart, this.tmpA, e);
    const shake = 0.002 + 0.004 * e;
    this.face.position.set(
      this.tmpA.x + jitter(this.time, 21, 26) * shake,
      this.tmpA.y + jitter(this.time, 22, 23) * shake,
      this.tmpA.z,
    );
    this.root.localToWorld(this.facePos.copy(this.face.position));
    this.face.lookAt(ctx.headPos);
    this.face.rotateZ(jitter(this.time, 23, 19) * 0.06);
    const s = lerp(1, 1.25, e);
    this.face.scale.set(FACE_SCALE_X * s, FACE_SCALE_Y * s, FACE_SCALE_Z * s);
    this.faceMat.opacity = 1;
    this.faceMat.color.setScalar(1.1 + 0.1 * jitter(this.time, 24, 28));
    this.smearAmt = damp(this.smearAmt, 0, 6, dt);
    this.smearMat.opacity = this.smearAmt;
    this.overVoice.setPosition(this.facePos);
  }

  // ─── Helpers ───────────────────────────────────────────────────────────

  private sync(attack: AttackView): void {
    this.meter = attack.meter;
    this.countering = attack.countering;
    this.teaching = attack.teaching;
  }

  /** Frame at the window centre: +Z into the room, +Y up. */
  private placeFrame(ctx: FrameContext, win: RoomFeature | null): void {
    if (win) {
      this.root.position.copy(win.position);
      orientToForward(this.root, win.normal);
    } else {
      // Defensive only (available() needs a window): a "window" 2 m ahead, facing the player.
      pointInFrontOfHead(ctx.headPos, ctx.headForward, 2, 0.1, this.tmpA);
      this.root.position.copy(this.tmpA);
      this.tmpB.copy(ctx.headForward).multiplyScalar(-1);
      orientToForward(this.root, this.tmpB);
    }
    this.root.updateMatrixWorld(true);
    this.hasFrame = true;
  }

  /** Put the face at `depth` along the window normal, staring at the head. */
  private placeFace(ctx: FrameContext, depth: number, shake: number, squashY: number): void {
    const t = this.time;
    this.face.position.set(
      this.lat + wobble(t * 0.21, 4) * 0.01 + jitter(t, 11, 24) * shake,
      this.vert + wobble(t * 0.35, 1.3) * 0.012 + jitter(t, 12, 21) * shake,
      depth,
    );
    this.face.scale.set(FACE_SCALE_X, FACE_SCALE_Y * squashY, FACE_SCALE_Z);
    this.root.localToWorld(this.facePos.copy(this.face.position));
    this.face.lookAt(ctx.headPos);
    // A slow, curious head tilt; a shudder when it flinches.
    this.face.rotateZ(wobble(t * 0.3, 2) * 0.06 + jitter(t, 13, 17) * shake * 8);
  }

  private setVariant(v: FaceVariant): void {
    if (v === this.variant) return;
    this.variant = v;
    this.faceMat.map = this.maps[v];
  }

  hideVisuals(): void {
    this.mode = 'idle';
    this.modeT = 0;
    this.meter = 0;
    this.countering = false;
    this.opacity = 0;
    this.smearAmt = 0;
    this.lit = 0;
    this.flinch = 0;
    if (this.root) this.root.visible = false;
    if (this.faceMat) {
      this.faceMat.opacity = 0;
      this.setVariant('calm');
    }
    if (this.smearMat) this.smearMat.opacity = 0;
  }

  private releaseAudio(fadeSec: number): void {
    this.taps.stop(fadeSec);
    this.voice.release(fadeSec);
    this.overVoice.release(fadeSec);
    this.lingerLeft = 0;
  }
}
