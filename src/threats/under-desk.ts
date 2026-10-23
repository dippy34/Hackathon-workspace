/**
 * The Thing Under the Desk (DESIGN.md). Counter (LOCKED): both hands flat.
 *
 * Warning: fingernails on wood from under the desk, near the player's knees.
 * Mostly unseen: two small pale eyes looking up from the dark gap at the
 * knees and, as the meter rises, four long bony fingers that crest the near
 * edge one after another and walk onto the desk between the player's hands.
 * Below the desk surface the hand sinks into black (the 'desk shadow'), and in
 * the dark only its top-facing knuckles, nails and rim catch any light; the
 * flashlight is the reveal. Countered: the fingers twitch, tremble and slowly
 * slide back down; the scratching nearly stops (ducked to threatFx.counterDuck).
 * Leave: they withdraw, deskRetreat. Caught: the hand lunges up out of the dark
 * at the face (~0.35 s) with a 'grab' on the over-bus, its long fingers spread
 * past the edges of the view and close over the eyes as it goes dark, then the
 * director cuts to black.
 *
 * Everything is built once in init() (the creature-hand rig: 16 unlit opaque
 * meshes sharing one baked-vertex-colour material, faded with its colour) and
 * reused for every attack.
 */

import { Group, type MeshBasicMaterial, Object3D, Quaternion, Vector3, type World } from '@iwsdk/core';
import { CONFIG } from '../config.js';
import type { AttackView } from '../core/types.js';
import type { FrameContext, ThreatPresenter } from '../game/contracts.js';
import {
  type CreatureHandRig,
  FINGER_SPLAY,
  createCreatureHand,
  setCreatureHandShade,
} from '../scene-assets/creature-hand.scene-asset.js';
import {
  GlowingEyes,
  LoopSlot,
  PALETTE,
  RENDER_ORDER,
  VoiceSlot,
  clamp,
  clamp01,
  damp,
  easeInCubic,
  easeInOutSine,
  easeOutCubic,
  jitter,
  lerp,
  orientToForward,
  pointInFrontOfHead,
  randRange,
  smoothstep,
  wobble,
} from './common.js';

const FX = CONFIG.threatFx.underDesk;

/**
 * Caught: the claw closes over the face between these times (s into the caught moment), on the
 * lunge's own timeline but scaled earlier if needed, so it is always closed before the cut to black.
 */
const CLAW_CLOSED_SEC = Math.min(
  FX.clawClosedAtLunges * FX.lungeSec,
  FX.clawClosedByCutFrac * CONFIG.caught.cutToBlackSec,
);
const CLAW_CLOSE_FROM_SEC = CLAW_CLOSED_SEC * (FX.clawCloseFromLunges / FX.clawClosedAtLunges);

type Mode = 'idle' | 'active' | 'leaving' | 'caught';

// ─── Hand poses (hand-local: +Y = fingers, +Z = back of the hand) ─────────

// The model and its joint contract (fingers[i][k], thumb[k], FINGER_SPLAY, ...)
// live in src/scene-assets/creature-hand.scene-asset.ts.

// Joint curls (rad; negative curls over the desk, away from the player).
const POSE_UP = [0.0, -0.12, -0.15] as const;
/** Cresting the edge from below: the proximal phalanges stand in front of the edge, the rest curl over onto the wood. */
const POSE_CREST = [-0.15, -1.2, -0.7] as const;
const POSE_HOOK = [-1.25, -0.55, -0.38] as const;
/** Full reach: an arched 'spider' grip; the middle knuckles stand high and the nails dig into the wood. */
const POSE_REACH = [-1.05, -0.75, -0.35] as const;
/** The lunge: a hooked claw reaching for your face, knuckles back and nails toward you. */
const POSE_CLAW = [0.15, -0.9, -0.75] as const;
/** The smother: the long fingers arc out past the edges of the view instead of folding back at the eyes. */
const POSE_GRAB = [-0.1, -0.8, -0.5] as const;
/** Caught spread, in multiples of the rest FINGER_SPLAY, outward (FINGER_SPLAY draws the tips together, hence negative). */
const GRAB_SPLAY = -5;
/** Creep progress at which the fingers have crested the edge (knuckles still down in the dark)... */
const CREST_AT = 0.3;
/** ...the knuckle height then (m, relative to the desk surface)... */
const CREST_HY = -0.06;
/** ...and the progress at which the hand has pulled itself up and hooked over the edge. */
const HOOK_AT = 0.55;
/** Knuckle height above the desk surface at full reach (m): the arch puts the nails on the wood. */
const REACH_HY = 0.062;
/** Per-finger lag of the creep (index leads, the pinky arrives last and stays a little behind). */
const FINGER_LAG = [0, 0.05, 0.1, 0.16] as const;
/** Per-finger joint bias (rad) so no two fingers share a pose. */
const FINGER_BIAS = [
  [0.04, -0.12, 0.04],
  [0.06, 0, 0],
  [-0.02, 0.12, -0.08],
  [0.1, -0.25, -0.2],
] as const;
/** Extra splay at full reach (rad, outward is against FINGER_SPLAY's sign): the outer fingers spread, the pinky out to ~0.16. */
const REACH_SPLAY = [0.05, 0.01, -0.04, -0.24] as const;
/** The walk: one finger at a time lifts (slot order index, ring, middle, pinky) while the others press. */
const WALK_SLOT = [0, 2, 1, 3] as const;
const WALK_PERIOD_SEC = 2.0;
/** Fraction of the cycle a finger is lifted (a little overlap between neighbours). */
const WALK_LIFT = 0.3;

export class UnderDeskThreat implements ThreatPresenter {
  readonly id = 'underDesk' as const;
  readonly teachingHint = 'Hands flat.';

  private root!: Group;
  private rig!: CreatureHandRig;
  private hand!: Group;
  private aimer!: Object3D;
  private mat!: MeshBasicMaterial;
  private eyes!: GlowingEyes;
  /** rig.fingers[i][k]: index..pinky, proximal..distal joints. */
  private fingers: Object3D[][] = [];
  /** rig.thumb[k]: proximal, distal joints. */
  private thumb: Object3D[] = [];

  private readonly scratch = new LoopSlot();
  private readonly voice = new VoiceSlot();
  private readonly overVoice = new VoiceSlot();

  private mode: Mode = 'idle';
  private hasFrame = false;
  private meter = 0;
  private countering = false;
  private wasCountering = false;
  private teaching = false;

  private time = 0;
  private modeT = 0;
  private lingerLeft = 0;
  /** Smoothed creep progress 0..1 (from the meter). */
  private p = 0;
  private fade = 0;
  private eyeFade = 0;
  private counterBlend = 0;
  private twitch = 0;
  private lit = 0;
  private eyeLit = 0;
  private handX = 0;
  private eyeX = 0;
  private leaveStartP = 0;
  private leaveStartFade = 0;

  private readonly pose = [0, 0, 0];
  /** Finger joint angles when caught (per finger: 3 curls, then the splay). */
  private readonly grabFrom = new Float32Array(16);
  private readonly edge = new Vector3();
  private readonly toward = new Vector3();
  private readonly voicePos = new Vector3();
  private readonly lungeStart = new Vector3();
  private readonly lungeStartQ = new Quaternion();
  /** The gaze's own up (world), see gazeUp(). */
  private readonly upG = new Vector3();
  /** Inverse of this.root's world rotation (world directions to root-local). */
  private readonly rootQInv = new Quaternion();
  private readonly tmpA = new Vector3();
  private readonly tmpB = new Vector3();

  init(world: World): void {
    this.root = new Group();
    this.root.name = 'threat-under-desk';
    world.createTransformEntity(this.root, { persistent: true });
    this.root.visible = false;

    // The rig's own root stays at identity under this.root, so the hand's parent
    // frame is this.root's (lunge maths and the aimer rely on that).
    const rig = createCreatureHand({ renderOrder: RENDER_ORDER.body });
    this.rig = rig;
    this.mat = rig.material;
    rig.shade.uHsFloor.value.set(FX.shadowColor);
    rig.shade.uHsFade.value = 0;
    this.hand = rig.hand;
    this.fingers = rig.fingers;
    this.thumb = rig.thumb;
    this.root.add(rig.root);

    this.aimer = new Object3D();
    this.root.add(this.aimer);

    this.eyes = new GlowingEyes({ spacing: 0.062, size: 0.05, color: PALETTE.sickly });
    this.root.add(this.eyes.group);
  }

  available(ctx: FrameContext): boolean {
    return ctx.desk != null;
  }

  isCountering(ctx: FrameContext): boolean {
    return ctx.hands.bothFlat;
  }

  begin(attack: AttackView, ctx: FrameContext): void {
    this.releaseAudio(0.05);
    this.placeFrame(ctx);
    this.handX = randRange(-0.07, 0.07);
    this.eyeX = clamp(-this.handX * 0.5 + randRange(-0.03, 0.03), -0.08, 0.08);
    this.p = 0;
    this.fade = 0;
    this.eyeFade = 0;
    this.counterBlend = 0;
    this.twitch = 0;
    this.lit = 0;
    this.eyeLit = 0;
    this.wasCountering = false;
    this.modeT = 0;
    this.mode = 'active';
    this.sync(attack);
    this.rig.shade.uHsFade.value = 0;
    this.rig.shade.uHsLit.value = 0;
    this.mat.color.setScalar(FX.darkBrightness);
    this.poseCreep(0, 0, 0);
    this.eyes.set(0);
    this.root.visible = true;

    this.voice.openAt(ctx.audio, this.voicePos, 'game');
    const loopIn = this.voice.loopInput;
    if (loopIn) this.scratch.start(ctx.audio.sounds.scratching(loopIn), 0.3);
  }

  update(attack: AttackView, _ctx: FrameContext): void {
    if (this.mode === 'active') this.sync(attack);
  }

  leave(ctx: FrameContext): void {
    if (this.mode !== 'active') return;
    this.mode = 'leaving';
    this.modeT = 0;
    this.leaveStartP = this.p;
    this.leaveStartFade = this.fade;
    this.twitch = 1;
    this.scratch.stop(0.35);
    const input = this.voice.input;
    if (input) ctx.audio.sounds.oneShot('deskRetreat', input);
    this.lingerLeft = CONFIG.threatFx.voiceLingerSec;
  }

  caught(ctx: FrameContext): void {
    if (!this.hasFrame || this.mode === 'idle') this.placeFrame(ctx);
    this.scratch.stop(0.05);
    this.voice.release(0.08);
    this.lingerLeft = 0;
    // Lunge from wherever the hand is; if it never came up, from under the desk.
    if (this.mode !== 'active' || this.p < 0.15) {
      this.hand.position.set(this.handX, -FX.lungeHiddenBelowM, FX.lungeHiddenTowardM);
      this.hand.rotation.set(0, 0, 0);
    }
    this.hand.scale.setScalar(1);
    this.lungeStart.copy(this.hand.position);
    // A hand that is not ahead of the gaze, in 3D and in plan view (the player looking away from, or
    // high over, the desk), would sweep through the head on its way to the face: it comes up out of
    // view in front of them instead.
    const fwd = ctx.headForward;
    const r = this.root.localToWorld(this.tmpA.copy(this.lungeStart)).sub(ctx.headPos);
    const minCos = FX.lungeAheadMinCos;
    const ahead =
      r.dot(fwd) >= minCos * r.length() &&
      r.x * fwd.x + r.z * fwd.z >= minCos * Math.hypot(r.x, r.z) * Math.hypot(fwd.x, fwd.z);
    if (!ahead) {
      const upG = this.gazeUp(fwd, this.tmpB, ctx.head);
      this.tmpA.copy(ctx.headPos).addScaledVector(fwd, FX.lungeRestartAheadM);
      this.tmpA.addScaledVector(upG, -FX.lungeRestartBelowM);
      this.lungeStart.copy(this.root.worldToLocal(this.tmpA));
    }
    this.lungeStartQ.copy(this.hand.quaternion);
    this.root.getWorldQuaternion(this.rootQInv).invert();
    // The fingers fly open from wherever they are.
    for (let i = 0; i < 4; i++) {
      const j = this.fingers[i];
      const f = i * 4;
      this.grabFrom[f] = j?.[0]?.rotation.x ?? 0;
      this.grabFrom[f + 1] = j?.[1]?.rotation.x ?? 0;
      this.grabFrom[f + 2] = j?.[2]?.rotation.x ?? 0;
      this.grabFrom[f + 3] = j?.[0]?.rotation.z ?? FINGER_SPLAY[i] ?? 0;
    }
    this.mode = 'caught';
    this.modeT = 0;
    this.rig.shade.uHsFade.value = 1;
    this.mat.color.setScalar(FX.caughtBrightness);
    this.root.visible = true;

    this.root.localToWorld(this.tmpA.copy(this.hand.position));
    const input = this.overVoice.openAt(ctx.audio, this.tmpA, 'over', 0.3);
    if (input) ctx.audio.sounds.oneShot('grab', input, FX.grabGain);
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
    if (this.hasFrame) return this.root.localToWorld(out.set(this.handX * 0.5, 0.15, -0.06));
    return pointInFrontOfHead(ctx.headPos, ctx.headForward, 0.55, -0.25, out);
  }

  reset(): void {
    this.releaseAudio(0.05);
    this.hideVisuals();
  }

  // ─── Per-mode animation ────────────────────────────────────────────────

  private tickActive(ctx: FrameContext, dt: number): void {
    if (this.countering && !this.wasCountering) {
      // The moment both hands slam down: it flinches.
      this.twitch = 1;
      this.eyes.blink();
    }
    this.wasCountering = this.countering;
    this.twitch = Math.max(0, this.twitch - dt * 1.6);
    this.counterBlend = damp(this.counterBlend, this.countering ? 1 : 0, 6, dt);

    // Creep up fast with the meter, slide back down slowly when held off.
    const target = smoothstep(0.03, 0.97, this.meter);
    this.p = damp(this.p, target, target > this.p ? 7 : 1.4, dt);
    this.fade = damp(this.fade, smoothstep(0.02, 0.2, this.p), 8, dt);
    this.eyeFade = Math.min(1, this.eyeFade + dt / FX.eyeFadeInSec);

    this.poseCreep(this.p, this.counterBlend, this.twitch);

    // Fake flashlight: in the beam the bone brightens, the shading turns frontal and the
    // desk shadow pulls back under the desk (the reveal); eyeshine flares.
    this.lit = damp(this.lit, this.inBeam(ctx, this.hand) ? 1 : 0, 10, dt);
    this.eyeLit = damp(this.eyeLit, this.inBeam(ctx, this.eyes.group) ? 1 : 0, 10, dt);
    this.mat.color.setScalar(lerp(FX.darkBrightness, FX.litBrightness, this.lit));
    this.rig.shade.uHsFade.value = this.fade;
    this.rig.shade.uHsLit.value = this.lit;
    this.setShade(this.edge.y - FX.shadeLitDropM * this.lit);

    const cb = this.counterBlend;
    const eyeI =
      this.eyeFade * (0.3 + 0.55 * this.meter) * (1 - 0.5 * cb) * (this.teaching ? 1.25 : 1) * (1 + 0.8 * this.eyeLit);
    this.updateEyes(ctx, dt, eyeI, 1 - 0.6 * cb);

    // Danger you can hear: scratching follows the meter, and almost stops while held down.
    this.scratch.set((0.3 + 0.7 * this.meter) * lerp(1, 0.22, cb));
    this.voice.setDuck(this.countering ? CONFIG.threatFx.counterDuck : 1, CONFIG.threatFx.counterDuckSec);
  }

  private tickLeaving(ctx: FrameContext, dt: number): void {
    this.modeT += dt;
    const t = clamp01(this.modeT / FX.withdrawSec);
    this.twitch = Math.max(0, this.twitch - dt * 2.5);
    // One last twitch, then a quick slide down under the desk.
    const slide = easeInCubic(t);
    this.p = this.leaveStartP * (1 - slide);
    this.poseCreep(this.p, 1, this.twitch);
    this.hand.position.y -= slide * 0.08;
    // It sinks into the desk shadow and into the dark (uHsFade, not opacity: the material is opaque).
    this.rig.shade.uHsFade.value = this.leaveStartFade * (1 - smoothstep(0.35, 1, t));
    this.eyeFade = Math.max(0, this.eyeFade - dt / 0.45);
    this.updateEyes(ctx, dt, this.eyeFade * 0.4, 0.3);
    if (t >= 1) this.hideVisuals();
  }

  private tickCaught(ctx: FrameContext, dt: number): void {
    this.modeT += dt;
    const u = this.modeT / FX.lungeSec;
    const t = clamp01(u);
    const e = easeOutCubic(t);
    // A clawed reach through the lunge; the claw closes over the face right up to the cut to black.
    const g = smoothstep(CLAW_CLOSE_FROM_SEC, CLAW_CLOSED_SEC, this.modeT);

    // Lunge target: just in front of the eyes, a little low in the gaze's own frame (root-local),
    // arcing up (in the view, so never toward a down-turned face) on the way.
    const upG = this.gazeUp(ctx.headForward, this.upG, ctx.head);
    this.tmpB.copy(ctx.headPos).addScaledVector(ctx.headForward, FX.lungeFaceDistM);
    this.tmpB.addScaledVector(upG, -FX.lungeDropM);
    this.root.worldToLocal(this.tmpA.copy(this.tmpB));
    const hold = smoothstep(0.9, 1.2, u);
    const shake = 0.004 * hold;
    this.hand.position.lerpVectors(this.lungeStart, this.tmpA, e);
    this.tmpB.copy(upG).applyQuaternion(this.rootQInv);
    this.hand.position.addScaledVector(this.tmpB, Math.sin(Math.PI * t) * FX.lungeArcM);
    this.hand.position.x += jitter(this.time, 4, 21) * shake;
    this.hand.position.y += jitter(this.time, 5, 19) * shake;
    this.hand.scale.setScalar(lerp(1, FX.lungeScale, e));
    // It rises out of the desk shadow, which then sinks away so the whole lunge stays visible.
    this.setShade(this.edge.y - FX.lungeShadeSinkM * smoothstep(0.2, 1, t));

    // Palm toward the face: aim the back of the hand (+Z) away from the head.
    this.root.localToWorld(this.tmpB.copy(this.hand.position));
    this.tmpB.multiplyScalar(2).sub(ctx.headPos);
    this.aimer.position.copy(this.hand.position);
    // Roll to the gaze's up so the fingers always rise up the view, whatever the head's pitch.
    this.aimer.up.copy(this.upG);
    this.aimer.lookAt(this.tmpB);
    this.hand.quaternion.slerpQuaternions(this.lungeStartQ, this.aimer.quaternion, smoothstep(0, 0.6, t));

    // Fingers hook into a wide claw, then close over the face (a smother, not a fist).
    const open = smoothstep(0, 0.45, t);
    const pose = this.pose;
    for (let k = 0; k < 3; k++) pose[k] = lerp(POSE_CLAW[k] ?? 0, POSE_GRAB[k] ?? 0, g);
    for (let i = 0; i < 4; i++) {
      const j = this.fingers[i];
      const b = FINGER_BIAS[i];
      if (!j || !b) continue;
      const tw = 0.12 * jitter(this.time, i * 5.3, 15) * (1 - g * 0.5);
      const f = i * 4;
      const from = this.grabFrom;
      j[0]?.rotation.set(
        lerp(from[f]!, pose[0]! + 0.5 * b[0] * g + tw * 0.4, open),
        0,
        lerp(from[f + 3]!, (FINGER_SPLAY[i] ?? 0) * lerp(GRAB_SPLAY, 0.7 * GRAB_SPLAY, g), open),
      );
      if (j[1]) j[1].rotation.x = lerp(from[f + 1]!, pose[1]! + 0.5 * b[1] * g + tw, open);
      if (j[2]) j[2].rotation.x = lerp(from[f + 2]!, pose[2]! + 0.5 * b[2] * g + tw * 0.8, open);
    }
    // The thumb stays tucked and opposes toward the palm and the face (never out sideways).
    this.setThumb(lerp(-1.45, -1.3, e) - g * 0.3, 0.35 - g * 0.2);

    // Filling the view it takes the flat frontal response (no top-light two-tone across the
    // curled fingers), then darkens as it covers you: the cut to black reads as the hand over your eyes.
    this.rig.shade.uHsLit.value = Math.max(this.rig.shade.uHsLit.value, smoothstep(0, 0.5, t));
    this.mat.color.setScalar(
      lerp(FX.caughtBrightness, FX.caughtCoveredBrightness, g) + FX.caughtFlicker * jitter(this.time, 9, 30),
    );
    this.eyeFade = Math.max(0, this.eyeFade - dt / 0.1);
    this.updateEyes(ctx, dt, this.eyeFade * 0.6, 1);

    this.root.localToWorld(this.tmpB.copy(this.hand.position));
    this.overVoice.setPosition(this.tmpB);
  }

  // ─── Helpers ───────────────────────────────────────────────────────────

  private sync(attack: AttackView): void {
    this.meter = attack.meter;
    this.countering = attack.countering;
    this.teaching = attack.teaching;
  }

  /** World frame at the desk's near edge (desk-surface height), +Z toward the player. */
  private placeFrame(ctx: FrameContext): void {
    const desk = ctx.desk;
    if (desk) {
      this.toward.copy(desk.towardPlayer);
      this.edge.copy(desk.center).addScaledVector(desk.towardPlayer, FX.nearEdgeM);
      this.edge.y = desk.height - FX.palmAboveSurfaceM;
      this.voicePos.copy(desk.center).addScaledVector(desk.towardPlayer, FX.voiceTowardPlayerM);
      this.voicePos.y = desk.height - FX.voiceBelowDeskM;
    } else {
      // Defensive only (available() needs a desk): assume an edge 0.35 m ahead, 0.45 m below the eyes.
      this.toward.set(-ctx.headForward.x, 0, -ctx.headForward.z);
      if (this.toward.lengthSq() < 1e-6) this.toward.set(0, 0, 1);
      this.toward.normalize();
      this.edge.copy(ctx.headPos).addScaledVector(this.toward, -0.35);
      this.edge.y = ctx.headPos.y - 0.45;
      this.voicePos.copy(this.edge).addScaledVector(this.toward, FX.voiceTowardPlayerM - FX.nearEdgeM);
      this.voicePos.y = this.edge.y - FX.voiceBelowDeskM;
    }
    this.root.position.copy(this.edge);
    orientToForward(this.root, this.toward);
    this.root.updateMatrixWorld(true);
    this.hasFrame = true;
    this.setShade(this.edge.y);
  }

  /**
   * The gaze's own up (world up made perpendicular to `forward`) into `out`. Looking straight up or
   * down it falls back to the head's own up axis, so it is never zero.
   */
  private gazeUp(forward: Vector3, out: Vector3, head: Object3D): Vector3 {
    out.set(0, 1, 0).addScaledVector(forward, -forward.y);
    if (out.lengthSq() < 1e-6) out.setFromMatrixColumn(head.matrixWorld, 1);
    return out.normalize();
  }

  /** The desk shadow at world height y (the desk surface, or lower to reveal more). */
  private setShade(y: number): void {
    setCreatureHandShade(this.rig, y, FX.shadeDepthM, FX.shadeLiftM);
  }

  /** Pose the fingers for creep progress p (0 under the desk .. 1 reaching onto it). */
  private poseCreep(p: number, cb: number, tw: number): void {
    const t = this.time;
    let hy: number;
    let hz: number;
    let pitch: number;
    if (p < CREST_AT) {
      hy = lerp(-0.175, CREST_HY, p / CREST_AT);
      hz = 0.006;
      pitch = 0;
    } else if (p < HOOK_AT) {
      hy = lerp(CREST_HY, 0.016, easeInOutSine((p - CREST_AT) / (HOOK_AT - CREST_AT)));
      hz = 0.006;
      pitch = 0;
    } else {
      const k = (p - HOOK_AT) / (1 - HOOK_AT);
      // Knuckles rise over the edge; the back of the hand tilts toward the player (pulling itself up).
      hy = lerp(0.016, REACH_HY, k);
      hz = lerp(0.006, 0, k);
      pitch = lerp(0, -0.45, k);
    }

    const shake = tw * 0.004;
    this.hand.position.set(
      this.handX + jitter(t, 1, 23) * shake,
      hy + jitter(t, 2, 19) * shake - cb * 0.008,
      hz,
    );
    this.hand.rotation.set(pitch, 0, 0.08 + wobble(t * 0.4, 3) * 0.03);
    this.hand.scale.setScalar(1);

    // The walk: one finger at a time lifts while the others press their nails into the wood;
    // trembling while held off; a jolt on the counter. Each finger runs its own lagged creep.
    const walk = smoothstep(0.3, 0.75, p) * (1 - 0.75 * cb);
    const cyc = t / WALK_PERIOD_SEC;
    const bias = smoothstep(0.1, 0.5, p);
    const pose = this.pose;
    for (let i = 0; i < 4; i++) {
      const j = this.fingers[i];
      const b = FINGER_BIAS[i];
      if (!j || !b) continue;
      const reach = this.creepPose(Math.max(0, p - (FINGER_LAG[i] ?? 0)));
      let ph = cyc + (WALK_SLOT[i] ?? 0) * 0.25;
      ph -= Math.floor(ph);
      const lift = ph < WALK_LIFT ? Math.sin((Math.PI * ph) / WALK_LIFT) : 0;
      const up = 0.25 * walk * lift;
      const press = 0.05 * walk * (1 - lift);
      const tremble = cb * 0.05 * jitter(t, i * 3.3 + 2, 11);
      const tws = tw * 0.24 * jitter(t, i * 7.1 + 1, 17);
      const splay = (FINGER_SPLAY[i] ?? 0) + (REACH_SPLAY[i] ?? 0) * reach;
      j[0]?.rotation.set(pose[0]! + b[0] * bias + up + tws * 0.5 + tremble * 0.4, 0, splay);
      if (j[1]) j[1].rotation.x = pose[1]! + b[1] * bias - 0.4 * up - press + tws + tremble;
      if (j[2]) j[2].rotation.x = pose[2]! + b[2] * bias - 0.3 * up - 1.3 * press + tws * 0.8 + tremble;
    }
    this.setThumb(-1.45, 0.35);
  }

  /** Joint curls for (one finger's) creep progress q into this.pose; returns how far into the reach (0..1) it is. */
  private creepPose(q: number): number {
    const pose = this.pose;
    if (q < CREST_AT) {
      // Straight up until the tips clear the edge, then they curl over it.
      const k = smoothstep(0.3, 1, q / CREST_AT);
      for (let i = 0; i < 3; i++) pose[i] = lerp(POSE_UP[i] ?? 0, POSE_CREST[i] ?? 0, k);
      return 0;
    }
    if (q < HOOK_AT) {
      const k = easeInOutSine((q - CREST_AT) / (HOOK_AT - CREST_AT));
      for (let i = 0; i < 3; i++) pose[i] = lerp(POSE_CREST[i] ?? 0, POSE_HOOK[i] ?? 0, k);
      return 0;
    }
    const k = (q - HOOK_AT) / (1 - HOOK_AT);
    for (let i = 0; i < 3; i++) pose[i] = lerp(POSE_HOOK[i] ?? 0, POSE_REACH[i] ?? 0, k);
    return k;
  }

  private setThumb(curl: number, out: number): void {
    const a = this.thumb[0];
    const b = this.thumb[1];
    if (a) a.rotation.set(curl, 0, out);
    if (b) b.rotation.x = -0.35;
  }

  private updateEyes(ctx: FrameContext, dt: number, intensity: number, squint: number): void {
    const g = this.eyes.group;
    // In front of the edge and low: looking up out of the dark gap at the knees.
    g.position.set(this.eyeX, lerp(-0.3, -0.18, this.p), lerp(0.03, 0.05, this.p));
    g.lookAt(ctx.headPos);
    this.eyes.set(intensity, squint);
    this.eyes.update(dt);
  }

  private inBeam(ctx: FrameContext, obj: Object3D): boolean {
    if (!ctx.flashlight.on) return false;
    obj.getWorldPosition(this.tmpA);
    return ctx.flashlight.containsPoint(this.tmpA);
  }

  hideVisuals(): void {
    this.mode = 'idle';
    this.modeT = 0;
    this.p = 0;
    this.fade = 0;
    this.eyeFade = 0;
    this.twitch = 0;
    this.counterBlend = 0;
    this.meter = 0;
    this.countering = false;
    this.wasCountering = false;
    if (this.root) this.root.visible = false;
    if (this.rig) {
      this.rig.shade.uHsFade.value = 0;
      this.rig.shade.uHsLit.value = 0;
    }
    this.eyes?.set(0);
    this.eyes?.update(0);
  }

  private releaseAudio(fadeSec: number): void {
    this.scratch.stop(fadeSec);
    this.voice.release(fadeSec);
    this.overVoice.release(fadeSec);
    this.lingerLeft = 0;
  }
}
