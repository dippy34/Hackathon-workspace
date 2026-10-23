/**
 * The Peeker (DESIGN.md). Counter (LOCKED): flashlight on, beam on the face.
 *
 * Warning: tapping on the glass of one of the player's real windows, and a
 * pale, too-smooth face with dark hollow eyes fading in OUTSIDE it. As the
 * meter rises the face slowly comes through the glass into the room
 * (startOutsideM outside → fullInsideM inside at a full meter), and its mouth
 * hangs slack from about a third of the way. It always stares at the player;
 * its curious head tilt becomes an inhuman lean as the meter rises, with a
 * rare micro-twitch, and it surfaces out of the dark as it comes in.
 * Lit: it brightens (fake flashlight lighting), flinches, squeezes its eyes
 * shut, turns away a little and recoils; the taps all but stop (their loop is
 * ducked to threatFx.counterDuck).
 * Leave: it pulls back outside and fades, glassRetreat.
 * Caught: it rushes at the player's head (~0.4 s), screaming, faceRush on the
 * over-bus; it punches in past the stop and springs back, then keeps creeping
 * closer while the jaw drops past full and the head snaps to a cant. It is
 * never over-exposed: the strobe drops it to dark for a frame or two.
 *
 * Meshes: the sculpted face rig (scene-assets/peeker-face: the skin with
 * squint/scream morphs plus two tiny eye glints) and a faint breath-on-glass
 * haze at the window plane.
 */

import { AdditiveBlending, Group, Mesh, MeshBasicMaterial, Vector3, type World } from '@iwsdk/core';
import { CONFIG } from '../config.js';
import type { AttackView } from '../core/types.js';
import type { FrameContext, RoomFeature, ThreatPresenter } from '../game/contracts.js';
import { createPeekerFace, type PeekerFaceRig } from '../scene-assets/peeker-face.scene-asset.js';
import {
  LoopSlot,
  PALETTE,
  RENDER_ORDER,
  VoiceSlot,
  clamp,
  clamp01,
  damp,
  easeInOutSine,
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

/** Expression damping rates (1/s): the eyes snap shut, the mouth opens slowly, the scream is instant. */
const SQUINT_RATE = 10;
const SCREAM_RATE = 2.5;
const RUSH_EXPR_RATE = 16;
/** Caught arrival punch: a damped spring (rad/s, 1/s), normalised so its peak is FX.rushPunchM. */
const PUNCH_W = 22;
const PUNCH_DECAY = 6;
const PUNCH_PEAK_T = Math.atan(PUNCH_W / PUNCH_DECAY) / PUNCH_W;
const PUNCH_NORM = 1 / (Math.sin(PUNCH_W * PUNCH_PEAK_T) * Math.exp(-PUNCH_DECAY * PUNCH_PEAK_T));
/** The caught head-cant snap starts this long after arrival (s) and takes CANT_SNAP_SEC. */
const CANT_AT_SEC = 0.12;
const CANT_SNAP_SEC = 0.06;

export class PeekerThreat implements ThreatPresenter {
  readonly id = 'peeker' as const;
  readonly teachingHint = 'Pinch. Light it.';

  private root!: Group;
  private face!: PeekerFaceRig;
  /** The rig's root: positioned, aimed and scaled here. */
  private head!: Group;
  /** The rig's own skin material (keeps its expression-colour shader patch; never cloned). */
  private faceMat!: MeshBasicMaterial;
  private smear!: Mesh;
  private smearMat!: MeshBasicMaterial;
  /** Local z of the front of the skin (m, unscaled), for the rush's stopping distance. */
  private frontZ = 0.09;

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
  private turnSign = 1;
  private fadeIn = 0;
  private mSm = 0;
  private lit = 0;
  private flinch = 0;
  private recoil = 0;
  private squint = 0;
  private scream = 0;
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

    this.face = createPeekerFace({ renderOrder: RENDER_ORDER.body });
    this.head = this.face.root;
    this.head.scale.setScalar(FX.faceScale);
    this.faceMat = this.face.material;
    this.faceMat.opacity = 0;
    this.frontZ = this.face.skin.geometry.boundingBox?.max.z ?? this.frontZ;
    this.root.add(this.head);

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
    this.smear.scale.set(0.32 * FX.faceScale, 0.4 * FX.faceScale, 1);
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
    this.turnSign = randRange(-1, 1) < 0 ? -1 : 1;

    this.fadeIn = 0;
    this.mSm = 0;
    this.lit = 0;
    this.flinch = 0;
    this.recoil = 0;
    this.squint = 0;
    this.scream = 0;
    this.smearAmt = 0;
    this.opacity = 0;
    this.modeT = 0;
    this.mode = 'active';
    this.sync(attack);
    this.face.setExpression(0, 0);
    this.faceMat.opacity = 0;
    this.smearMat.opacity = 0;
    this.smear.position.set(this.lat, this.vert, 0.004);
    this.placeFace(ctx, -FX.startOutsideM, 0, 0);
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
    this.startDepth = this.head.position.z;
    this.startOpacity = this.opacity;
    this.taps.stop(0.3);
    const input = this.voice.input;
    if (input) ctx.audio.sounds.oneShot('glassRetreat', input);
    this.lingerLeft = CONFIG.threatFx.voiceLingerSec;
  }

  caught(ctx: FrameContext): void {
    if (!this.hasFrame || this.mode === 'idle') {
      this.placeFrame(ctx, pickRandom(ctx.room.windows));
      this.placeFace(ctx, 0, 0, 0);
    }
    this.taps.stop(0.05);
    this.voice.release(0.08);
    this.lingerLeft = 0;
    this.rushStart.copy(this.head.position);
    this.mode = 'caught';
    this.modeT = 0;
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
    this.placeFace(ctx, depth, 0.001 + 0.007 * this.flinch, this.flinch);

    // Eyes squeezed shut against the light; the mouth opens as it gets close, and shuts while it flinches.
    this.squint = damp(this.squint, Math.max(this.lit, this.flinch), SQUINT_RATE, dt);
    const open = FX.screamAtFullMeter * smoothstep(FX.screamFromMeter, 1, this.mSm) * (1 - this.flinch);
    this.scream = damp(this.scream, open, SCREAM_RATE, dt);
    this.face.setExpression(this.squint, this.scream);

    // Behind the glass it is a haze, more ghost than object; inside it is all there.
    const glass = lerp(FX.glassHaze, 1, smoothstep(-0.2, 0.02, depth));
    this.opacity = this.fadeIn * glass;
    this.faceMat.opacity = this.opacity;
    // It surfaces out of the dark as it comes in (the teaching pass keeps it findable at the window).
    const dark = this.teaching ? FX.darkBrightness : lerp(FX.darkBrightnessFar, FX.darkBrightness, this.mSm);
    const bright = lerp(dark, FX.litBrightness, this.lit) * (0.9 + 0.2 * this.mSm);
    this.faceMat.color.setScalar(bright * (this.teaching ? 1.15 : 1));
    // Once the face is through the glass the breath smear is behind it: draw the smear first,
    // so the skin's faded rim (which writes depth) cannot cut a dark outline out of it.
    this.smear.renderOrder = depth > -0.03 ? RENDER_ORDER.body - 1 : RENDER_ORDER.body + 2;

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
    this.placeFace(ctx, depth, 0.003 * (1 - t), this.flinch);
    this.squint = damp(this.squint, 0, 3, dt);
    this.scream = damp(this.scream, 0, 4, dt);
    this.face.setExpression(this.squint, this.scream);
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
    const s = FX.faceScale * lerp(1, FX.rushGrow, e);
    // After arrival: a punch past the stop that springs back (impact), then a slow creep closer.
    const after = Math.max(0, this.modeT - FX.rushSec);
    const hold = Math.max(0.1, CONFIG.caught.cutToBlackSec - FX.rushSec);
    const punch = FX.rushPunchM * PUNCH_NORM * Math.sin(PUNCH_W * after) * Math.exp(-PUNCH_DECAY * after);
    const creep = FX.rushCreepM * smoothstep(0, hold, after);
    // Stop with the skin's surface rushFaceDistM from the eyes, eye to eye (less the punch and creep).
    const dist = FX.rushFaceDistM - punch - creep + this.frontZ * s;
    pointInFrontOfHead(ctx.headPos, ctx.headForward, dist, -this.face.eyeCenter.y * s, this.tmpB);
    this.root.worldToLocal(this.tmpA.copy(this.tmpB));
    this.tmpA.lerpVectors(this.rushStart, this.tmpA, e);
    const shake = 0.002 + 0.004 * e;
    this.head.position.set(
      this.tmpA.x + jitter(this.time, 21, 26) * shake,
      this.tmpA.y + jitter(this.time, 22, 23) * shake,
      this.tmpA.z,
    );
    this.root.localToWorld(this.facePos.copy(this.head.position));
    this.head.lookAt(ctx.headPos);
    const cant = smoothstep(CANT_AT_SEC, CANT_AT_SEC + CANT_SNAP_SEC, after);
    this.head.rotateZ(jitter(this.time, 23, 19) * 0.06 + this.turnSign * FX.rushCantRad * cant);
    this.head.scale.setScalar(s);
    this.squint = damp(this.squint, 0, RUSH_EXPR_RATE, dt);
    // The jaw keeps dropping past full through the hold (the scream morph is overdriven).
    this.scream = damp(this.scream, lerp(1, FX.rushScreamMax, smoothstep(0, hold, after)), RUSH_EXPR_RATE, dt);
    this.face.setExpression(this.squint, this.scream);
    this.faceMat.opacity = 1;
    // Keep the baked form (no over-exposure); now and then the strobe drops it to dark for a frame or two.
    const strobe = jitter(this.time, 24, 28) > 0.7;
    this.faceMat.color.setScalar(strobe ? FX.rushStrobeLow : FX.rushBrightness + 0.05 * jitter(this.time, 25, 31));
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

  /** Put the face at `depth` along the window normal, staring at the head; `turn` (0..1) turns it from the beam. */
  private placeFace(ctx: FrameContext, depth: number, shake: number, turn: number): void {
    const t = this.time;
    this.head.position.set(
      this.lat + wobble(t * 0.21, 4) * 0.01 + jitter(t, 11, 24) * shake,
      this.vert + wobble(t * 0.35, 1.3) * 0.012 + jitter(t, 12, 21) * shake,
      depth,
    );
    this.head.scale.setScalar(FX.faceScale);
    this.root.localToWorld(this.facePos.copy(this.head.position));
    this.head.lookAt(ctx.headPos);
    // A slow, curious head tilt that becomes an inhuman lean as the meter rises, a rare
    // ~60 ms micro-twitch, and a shudder when it flinches.
    const tilt = lerp(FX.headTiltRad, FX.headLeanRad, smoothstep(0.4, 1, this.mSm));
    const twitch = smoothstep(0.9, 0.96, jitter(t, 31, 9)) * FX.twitchRad;
    this.head.rotateZ(wobble(t * 0.3, 2) * tilt + jitter(t, 13, 17) * shake * 8 - this.turnSign * twitch);
    if (twitch > 0) this.head.rotateX(0.4 * twitch);
    if (turn > 0.001) {
      this.head.rotateY(this.turnSign * FX.flinchTurnRad * turn);
      this.head.rotateX(0.5 * FX.flinchTurnRad * turn);
    }
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
    this.squint = 0;
    this.scream = 0;
    if (this.root) this.root.visible = false;
    if (this.face) {
      this.faceMat.opacity = 0;
      this.face.setExpression(0, 0);
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
