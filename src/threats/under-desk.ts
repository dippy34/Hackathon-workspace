/**
 * The Thing Under the Desk (DESIGN.md). Counter (LOCKED): both hands flat.
 *
 * Warning: fingernails on wood from under the desk, near the player's knees.
 * Mostly unseen: two small pale eyes low under the desk's near edge and, as
 * the meter rises, four long bony fingers that curl up over the near edge and
 * creep onto the desk between the player's hands. Countered: the fingers
 * twitch, tremble and slowly slide back down; the scratching nearly stops.
 * Leave: they withdraw, deskRetreat. Caught: a pale hand lunges up at the face
 * (~0.35 s) with a 'grab' on the over-bus, then the director cuts to black.
 *
 * Everything is built once in init() (about 20 tiny unlit meshes sharing one
 * material) and reused for every attack.
 */

import {
  CylinderGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  Quaternion,
  SphereGeometry,
  Vector3,
  type World,
} from '@iwsdk/core';
import { CONFIG } from '../config.js';
import type { AttackView } from '../core/types.js';
import type { FrameContext, ThreatPresenter } from '../game/contracts.js';
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
  shadeGeometry,
  smoothstep,
  wobble,
} from './common.js';

const FX = CONFIG.threatFx.underDesk;

type Mode = 'idle' | 'active' | 'leaving' | 'caught';

// ─── Hand model (metres, hand-local: +Y = fingers, +Z = back of the hand) ──

/** Phalanx lengths: proximal, middle, distal. Deliberately too long. */
const SEG_LEN = [0.068, 0.05, 0.036] as const;
const SEG_RADIUS = [0.0076, 0.0066, 0.0056] as const;
/** Index → pinky along the knuckle line. The thumb sits on the -X side. */
const FINGER_X = [-0.031, -0.0105, 0.0105, 0.03] as const;
const FINGER_SCALE = [0.95, 1.07, 1.0, 0.8] as const;
const FINGER_SPLAY = [-0.07, -0.022, 0.025, 0.08] as const;
const FINGER_PHASE = [0, 1.9, 3.7, 5.2] as const;
const THUMB_LEN = [0.044, 0.033] as const;
const THUMB_RADIUS = [0.0086, 0.0071] as const;

// Joint curls (rad; negative curls over the desk, away from the player).
const POSE_UP = [0.0, -0.12, -0.15] as const;
const POSE_HOOK = [-1.25, -0.55, -0.38] as const;
const POSE_REACH = [-1.42, -0.32, -0.22] as const;
const POSE_SPREAD = [-0.12, -0.18, -0.12] as const;
const POSE_GRAB = [-0.75, -0.95, -0.7] as const;
/** Creep progress at which the fingers are hooked over the edge. */
const HOOK_AT = 0.55;

/** How far in front of the eyes the caught hand ends up (m). */
const LUNGE_FACE_DIST = 0.15;

export class UnderDeskThreat implements ThreatPresenter {
  readonly id = 'underDesk' as const;
  readonly teachingHint = 'Hands flat.';

  private root!: Group;
  private hand!: Group;
  private aimer!: Object3D;
  private mat!: MeshBasicMaterial;
  private eyes!: GlowingEyes;
  private readonly fingers: Object3D[][] = [];
  private readonly thumb: Object3D[] = [];

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
  private readonly edge = new Vector3();
  private readonly toward = new Vector3();
  private readonly voicePos = new Vector3();
  private readonly lungeStart = new Vector3();
  private readonly lungeStartQ = new Quaternion();
  private readonly tmpA = new Vector3();
  private readonly tmpB = new Vector3();

  init(world: World): void {
    this.root = new Group();
    this.root.name = 'threat-under-desk';
    world.createTransformEntity(this.root, { persistent: true });
    this.root.visible = false;

    this.mat = new MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0,
      depthWrite: true,
    });
    this.hand = this.buildHand();
    this.root.add(this.hand);

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
    this.mat.opacity = 0;
    this.poseCreep(0, 0, 0);
    this.eyes.set(0);
    this.root.visible = true;

    const input = this.voice.openAt(ctx.audio, this.voicePos, 'game');
    if (input) this.scratch.start(ctx.audio.sounds.scratching(input), 0.3);
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
      this.hand.position.set(this.handX, -0.22, 0.03);
      this.hand.rotation.set(0, 0, 0);
    }
    this.hand.scale.setScalar(1);
    this.lungeStart.copy(this.hand.position);
    this.lungeStartQ.copy(this.hand.quaternion);
    this.mode = 'caught';
    this.modeT = 0;
    this.mat.opacity = 1;
    this.mat.color.setScalar(1.2);
    this.root.visible = true;

    this.root.localToWorld(this.tmpA.copy(this.hand.position));
    const input = this.overVoice.openAt(ctx.audio, this.tmpA, 'over', 0.3);
    if (input) ctx.audio.sounds.oneShot('grab', input, FX.grabGain);
  }

  tick(ctx: FrameContext): void {
    const dt = Math.min(ctx.dt, 0.1);
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
    this.eyeFade = Math.min(1, this.eyeFade + dt / 1.2);

    this.poseCreep(this.p, this.counterBlend, this.twitch);

    // Fake flashlight: the bone brightens in the beam, eyeshine flares.
    this.lit = damp(this.lit, this.inBeam(ctx, this.hand) ? 1 : 0, 10, dt);
    this.eyeLit = damp(this.eyeLit, this.inBeam(ctx, this.eyes.group) ? 1 : 0, 10, dt);
    this.mat.opacity = this.fade;
    this.mat.color.setScalar(lerp(0.62, 1.15, this.lit));

    const cb = this.counterBlend;
    const eyeI =
      this.eyeFade * (0.3 + 0.55 * this.meter) * (1 - 0.5 * cb) * (this.teaching ? 1.25 : 1) * (1 + 0.8 * this.eyeLit);
    this.updateEyes(ctx, dt, eyeI, 1 - 0.6 * cb);

    // Danger you can hear: scratching follows the meter, and almost stops while held down.
    this.scratch.set((0.3 + 0.7 * this.meter) * lerp(1, 0.22, cb));
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
    this.mat.opacity = this.leaveStartFade * (1 - smoothstep(0.35, 1, t));
    this.eyeFade = Math.max(0, this.eyeFade - dt / 0.45);
    this.updateEyes(ctx, dt, this.eyeFade * 0.4, 0.3);
    if (t >= 1) this.hideVisuals();
  }

  private tickCaught(ctx: FrameContext, dt: number): void {
    this.modeT += dt;
    const u = this.modeT / FX.lungeSec;
    const t = clamp01(u);
    const e = easeOutCubic(t);

    // Lunge target: just in front of the eyes, a little low (root-local).
    pointInFrontOfHead(ctx.headPos, ctx.headForward, LUNGE_FACE_DIST, -0.03, this.tmpB);
    this.root.worldToLocal(this.tmpA.copy(this.tmpB));
    const hold = smoothstep(0.9, 1.2, u);
    const shake = 0.004 * hold;
    this.hand.position.lerpVectors(this.lungeStart, this.tmpA, e);
    this.hand.position.x += jitter(this.time, 4, 21) * shake;
    this.hand.position.y += Math.sin(Math.PI * t) * 0.06 + jitter(this.time, 5, 19) * shake;
    this.hand.scale.setScalar(lerp(1, 1.2, e));

    // Palm toward the face: aim the back of the hand (+Z) away from the head.
    this.root.localToWorld(this.tmpB.copy(this.hand.position));
    this.tmpB.multiplyScalar(2).sub(ctx.headPos);
    this.aimer.position.copy(this.hand.position);
    this.aimer.lookAt(this.tmpB);
    this.hand.quaternion.slerpQuaternions(this.lungeStartQ, this.aimer.quaternion, smoothstep(0, 0.6, t));

    // Fingers fly open, then close on the face.
    const g = smoothstep(0.85, 1.6, u);
    const pose = this.pose;
    for (let k = 0; k < 3; k++) pose[k] = lerp(POSE_SPREAD[k] ?? 0, POSE_GRAB[k] ?? 0, g);
    for (let i = 0; i < 4; i++) {
      const j = this.fingers[i];
      if (!j) continue;
      const tw = 0.12 * jitter(this.time, i * 5.3, 15) * (1 - g * 0.5);
      j[0]?.rotation.set(pose[0]! + tw * 0.4, 0, (FINGER_SPLAY[i] ?? 0) * 3.2);
      if (j[1]) j[1].rotation.x = pose[1]! + tw;
      if (j[2]) j[2].rotation.x = pose[2]! + tw * 0.8;
    }
    this.setThumb(lerp(-1.45, -0.45, e) - g * 0.4, lerp(0.35, 1.0, e));

    this.mat.opacity = 1;
    this.mat.color.setScalar(1.2 + 0.08 * jitter(this.time, 9, 30));
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
  }

  /** Pose the fingers for creep progress p (0 under the desk .. 1 reaching onto it). */
  private poseCreep(p: number, cb: number, tw: number): void {
    const t = this.time;
    const pose = this.pose;
    let hy: number;
    let hz: number;
    let pitch: number;
    if (p < HOOK_AT) {
      const k = easeInOutSine(p / HOOK_AT);
      for (let i = 0; i < 3; i++) pose[i] = lerp(POSE_UP[i] ?? 0, POSE_HOOK[i] ?? 0, k);
      hy = lerp(-0.175, 0.016, easeOutCubic(p / HOOK_AT));
      hz = 0.014;
      pitch = 0;
    } else {
      const k = (p - HOOK_AT) / (1 - HOOK_AT);
      for (let i = 0; i < 3; i++) pose[i] = lerp(POSE_HOOK[i] ?? 0, POSE_REACH[i] ?? 0, k);
      hy = lerp(0.016, 0.034, k);
      hz = lerp(0.014, -0.045, k);
      pitch = lerp(0, -0.3, k);
    }

    const shake = tw * 0.004;
    this.hand.position.set(
      this.handX + jitter(t, 1, 23) * shake,
      hy + jitter(t, 2, 19) * shake - cb * 0.008,
      hz,
    );
    this.hand.rotation.set(pitch, 0, 0.08 + wobble(t * 0.4, 3) * 0.03);
    this.hand.scale.setScalar(1);

    // Feeling the surface; pressing and trembling while held off; a jolt on the counter.
    const crawl = 0.11 * smoothstep(0.3, 0.75, p) * (1 - 0.75 * cb);
    for (let i = 0; i < 4; i++) {
      const j = this.fingers[i];
      if (!j) continue;
      const c = crawl * Math.sin(t * 2.4 + (FINGER_PHASE[i] ?? 0));
      const tremble = cb * 0.05 * jitter(t, i * 3.3 + 2, 11);
      const tws = tw * 0.24 * jitter(t, i * 7.1 + 1, 17);
      j[0]?.rotation.set(pose[0]! + tws * 0.5 + tremble * 0.4, 0, FINGER_SPLAY[i] ?? 0);
      if (j[1]) j[1].rotation.x = pose[1]! + c + tws + tremble;
      if (j[2]) j[2].rotation.x = pose[2]! + c * 1.3 + tws * 0.8 + tremble;
    }
    this.setThumb(-1.45, 0.35);
  }

  private setThumb(curl: number, out: number): void {
    const a = this.thumb[0];
    const b = this.thumb[1];
    if (a) a.rotation.set(curl, 0, out);
    if (b) b.rotation.x = -0.35;
  }

  private updateEyes(ctx: FrameContext, dt: number, intensity: number, squint: number): void {
    const g = this.eyes.group;
    g.position.set(this.eyeX, lerp(-0.4, -0.25, this.p), lerp(-0.13, -0.07, this.p));
    g.lookAt(ctx.headPos);
    this.eyes.set(intensity, squint);
    this.eyes.update(dt);
  }

  private inBeam(ctx: FrameContext, obj: Object3D): boolean {
    if (!ctx.flashlight.on) return false;
    obj.getWorldPosition(this.tmpA);
    return ctx.flashlight.containsPoint(this.tmpA);
  }

  private hideVisuals(): void {
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
    if (this.mat) this.mat.opacity = 0;
    this.eyes?.set(0);
    this.eyes?.update(0);
  }

  private releaseAudio(fadeSec: number): void {
    this.scratch.stop(fadeSec);
    this.voice.release(fadeSec);
    this.overVoice.release(fadeSec);
    this.lingerLeft = 0;
  }

  /** Back of the hand, a forearm fading into the dark, four long fingers and a thumb. */
  private buildHand(): Group {
    const hand = new Group();
    const key = new Vector3(0, 0.25, 1);
    const segGeo = shadeGeometry(new CylinderGeometry(0.8, 1, 1, 6, 1).translate(0, 0.5, 0), PALETTE.bone, {
      light: key,
      min: 0.38,
    });
    const tipGeo = shadeGeometry(new CylinderGeometry(0.38, 1, 1, 6, 1).translate(0, 0.5, 0), PALETTE.bone, {
      light: key,
      min: 0.38,
    });
    const backGeo = shadeGeometry(
      new SphereGeometry(1, 10, 8).scale(0.043, 0.05, 0.014).translate(0, -0.042, -0.002),
      PALETTE.bone,
      { light: key, min: 0.3 },
    );
    const armGeo = shadeGeometry(
      new CylinderGeometry(0.021, 0.026, 0.34, 8, 4, true).translate(0, -0.25, -0.004),
      PALETTE.bone,
      { light: key, min: 0.25, fadeY: { opaqueY: -0.1, clearY: -0.36 } },
    );

    const back = new Mesh(backGeo, this.mat);
    const arm = new Mesh(armGeo, this.mat);
    back.renderOrder = RENDER_ORDER.body;
    arm.renderOrder = RENDER_ORDER.body;
    hand.add(back, arm);

    for (let i = 0; i < 4; i++) {
      const joints: Object3D[] = [];
      let parent: Object3D = hand;
      const s = FINGER_SCALE[i] ?? 1;
      for (let k = 0; k < 3; k++) {
        const joint = new Object3D();
        if (k === 0) joint.position.set(FINGER_X[i] ?? 0, 0, 0);
        else joint.position.y = (SEG_LEN[k - 1] ?? 0) * s;
        parent.add(joint);
        const seg = new Mesh(k === 2 ? tipGeo : segGeo, this.mat);
        const r = SEG_RADIUS[k] ?? 0.006;
        seg.scale.set(r, (SEG_LEN[k] ?? 0.04) * s, r * 0.9);
        seg.renderOrder = RENDER_ORDER.body;
        joint.add(seg);
        joints.push(joint);
        parent = joint;
      }
      this.fingers.push(joints);
    }

    let parent: Object3D = hand;
    for (let k = 0; k < 2; k++) {
      const joint = new Object3D();
      if (k === 0) joint.position.set(-0.042, -0.048, 0.006);
      else joint.position.y = THUMB_LEN[0];
      parent.add(joint);
      const seg = new Mesh(k === 1 ? tipGeo : segGeo, this.mat);
      const r = THUMB_RADIUS[k] ?? 0.007;
      seg.scale.set(r, THUMB_LEN[k] ?? 0.03, r * 0.9);
      seg.renderOrder = RENDER_ORDER.body;
      joint.add(seg);
      this.thumb.push(joint);
      parent = joint;
    }
    return hand;
  }
}
