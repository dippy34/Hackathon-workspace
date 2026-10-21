/**
 * The Knocker (DESIGN.md). Counter (LOCKED): a palm held out toward the door.
 *
 * Warning: the real door's handle rattles, then knocking, from the door's
 * real position at handle height; the creak of the door opening follows the
 * meter ("a little more each second"). Mostly unseen: a thin, sickly sliver
 * of light at the door's opening edge that widens as the meter rises, with a
 * faint wedge of that light on the floor. Near a full meter something stands
 * in the gap: the light is blocked by a shape, and two eyes catch.
 * Palm out: the sliver trembles and narrows (the door is pushed back), the
 * knocking falls away. Leave: the light closes, doorRetreat.
 * Caught: the door bursts open: light floods out and a thin dark figure
 * rushes at the player, doorBurst on the over-bus.
 *
 * Which side of the real door is the opening edge is unknown, so it is picked
 * at random per attack.
 */

import {
  AdditiveBlending,
  Group,
  Mesh,
  MeshBasicMaterial,
  Vector3,
  type CanvasTexture,
  type World,
} from '@iwsdk/core';
import { CONFIG } from '../config.js';
import type { AttackView } from '../core/types.js';
import type { FrameContext, RoomFeature, ThreatPresenter } from '../game/contracts.js';
import {
  GlowingEyes,
  LoopSlot,
  PALETTE,
  RENDER_ORDER,
  VoiceSlot,
  canvasTexture,
  clamp,
  clamp01,
  damp,
  easeInCubic,
  easeOutCubic,
  jitter,
  lerp,
  orientToForward,
  pickRandom,
  pointInFrontOfHead,
  randSign,
  smoothstep,
  unitPlane,
  wobble,
} from './common.js';

const FX = CONFIG.threatFx.knocker;

type Mode = 'idle' | 'active' | 'leaving' | 'caught';

/** The light sits this far in front of the door plane (m). */
const LIGHT_Z = 0.03;
/** Height of the shape standing in the gap (m), and of the rushing figure. */
const GAP_FIGURE_H = 1.78;
const RUSH_FIGURE_W = 0.62;
const RUSH_FIGURE_H = 1.95;
/** Figure's eyes above its centre (m). */
const RUSH_EYE_Y = 0.8;
/** The figure stops this far in front of the eyes (m). */
const RUSH_FACE_DIST = 0.25;

/** Soft vertical strip of light: bright core, soft sides, fading ends. */
function sliverTexture(): CanvasTexture {
  return canvasTexture(64, 256, (g, w, h) => {
    const hor = g.createLinearGradient(0, 0, w, 0);
    hor.addColorStop(0, 'rgba(255,255,255,0)');
    hor.addColorStop(0.2, 'rgba(255,255,255,0.8)');
    hor.addColorStop(0.5, 'rgba(255,255,255,1)');
    hor.addColorStop(0.8, 'rgba(255,255,255,0.8)');
    hor.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = hor;
    g.fillRect(0, 0, w, h);
    g.globalCompositeOperation = 'destination-in';
    const ver = g.createLinearGradient(0, 0, 0, h);
    ver.addColorStop(0, 'rgba(0,0,0,0)');
    ver.addColorStop(0.05, 'rgba(0,0,0,0.85)');
    ver.addColorStop(0.5, 'rgba(0,0,0,1)');
    ver.addColorStop(0.96, 'rgba(0,0,0,0.9)');
    ver.addColorStop(1, 'rgba(0,0,0,0.25)');
    g.fillStyle = ver;
    g.fillRect(0, 0, w, h);
  });
}

/** Light spilling across the floor: narrow at the door (top), wide and faint into the room. */
function wedgeTexture(): CanvasTexture {
  return canvasTexture(64, 128, (g, w, h) => {
    const grad = g.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, 'rgba(255,255,255,0.9)');
    grad.addColorStop(0.45, 'rgba(255,255,255,0.35)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.filter = 'blur(3px)';
    g.fillStyle = grad;
    g.beginPath();
    g.moveTo(w * 0.42, 0);
    g.lineTo(w * 0.58, 0);
    g.lineTo(w * 0.96, h);
    g.lineTo(w * 0.04, h);
    g.closePath();
    g.fill();
  });
}

/** Whatever stands in the gap, seen against the light: head, neck, shoulders filling the gap. */
function gapShapeTexture(): CanvasTexture {
  return canvasTexture(64, 256, (g, w, h) => {
    g.filter = 'blur(2px)';
    g.fillStyle = 'rgba(0,0,0,1)';
    g.beginPath();
    g.ellipse(w * 0.5, h * 0.075, w * 0.4, h * 0.068, 0, 0, Math.PI * 2);
    g.fill();
    g.fillRect(w * 0.27, h * 0.12, w * 0.46, h * 0.06);
    g.fillRect(w * 0.05, h * 0.17, w * 0.9, h * 0.83);
  });
}

/** A too-thin figure with a long neck and arms that hang past its knees. */
function figureTexture(): CanvasTexture {
  return canvasTexture(128, 256, (g, w, h) => {
    g.filter = 'blur(1.5px)';
    g.fillStyle = 'rgba(0,0,0,1)';
    const poly = (pts: ReadonlyArray<readonly [number, number]>): void => {
      g.beginPath();
      pts.forEach(([x, y], i) => (i === 0 ? g.moveTo(x * w, y * h) : g.lineTo(x * w, y * h)));
      g.closePath();
      g.fill();
    };
    g.beginPath();
    g.ellipse(w * 0.5, h * 0.085, w * 0.085, h * 0.06, 0, 0, Math.PI * 2);
    g.fill();
    g.fillRect(w * 0.465, h * 0.13, w * 0.07, h * 0.075);
    poly([[0.3, 0.2], [0.7, 0.2], [0.63, 0.56], [0.37, 0.56]]);
    poly([[0.3, 0.2], [0.255, 0.215], [0.195, 0.73], [0.235, 0.745], [0.335, 0.3]]);
    poly([[0.7, 0.2], [0.745, 0.215], [0.805, 0.73], [0.765, 0.745], [0.665, 0.3]]);
    poly([[0.37, 0.54], [0.495, 0.54], [0.475, 1], [0.405, 1]]);
    poly([[0.505, 0.54], [0.63, 0.54], [0.595, 1], [0.525, 1]]);
  });
}

function additive(map: CanvasTexture, color: number): MeshBasicMaterial {
  return new MeshBasicMaterial({
    map,
    color,
    transparent: true,
    opacity: 0,
    blending: AdditiveBlending,
    depthWrite: false,
  });
}

export class KnockerThreat implements ThreatPresenter {
  readonly id = 'knocker' as const;
  readonly teachingHint = 'Palm out. Hold it.';

  private root!: Group;
  private sliver!: Mesh;
  private sliverMat!: MeshBasicMaterial;
  private wedge!: Mesh;
  private wedgeMat!: MeshBasicMaterial;
  private flash!: Mesh;
  private flashMat!: MeshBasicMaterial;
  private gapShape!: Mesh;
  private gapShapeMat!: MeshBasicMaterial;
  private gapEyes!: GlowingEyes;
  private figure!: Group;
  private figureMat!: MeshBasicMaterial;
  private figureEyes!: GlowingEyes;

  private readonly knocks = new LoopSlot();
  private readonly creak = new LoopSlot();
  private readonly voice = new VoiceSlot();
  private readonly overVoice = new VoiceSlot();

  private mode: Mode = 'idle';
  private hasFrame = false;
  private meter = 0;
  private countering = false;
  private teaching = false;
  private ageSec = 0;

  private time = 0;
  private modeT = 0;
  private lingerLeft = 0;
  private doorW = 0.85;
  private doorH = 2;
  private floorY = -1;
  private edgeSign: 1 | -1 = 1;
  private edgeX = 0.4;
  private gapW = 0;
  private sliverX = 0;
  private fadeIn = 0;
  private mSm = 0;
  private push = 0;
  private startW = 0;
  private startOpacity = 0;

  /** Point the palm must face (the door's centre, world). */
  private readonly doorTarget = new Vector3();
  private readonly voicePos = new Vector3();
  private readonly rushStart = new Vector3();
  private readonly tmpA = new Vector3();
  private readonly tmpB = new Vector3();

  init(world: World): void {
    this.root = new Group();
    this.root.name = 'threat-knocker';
    world.createTransformEntity(this.root, { persistent: true });
    this.root.visible = false;

    const plane = unitPlane();
    const sliverTex = sliverTexture();
    this.sliverMat = additive(sliverTex, PALETTE.sicklyLight);
    this.sliver = new Mesh(plane, this.sliverMat);
    this.sliver.renderOrder = RENDER_ORDER.light;

    this.wedgeMat = additive(wedgeTexture(), PALETTE.sicklyLight);
    this.wedge = new Mesh(plane, this.wedgeMat);
    this.wedge.rotation.x = -Math.PI / 2;
    this.wedge.renderOrder = RENDER_ORDER.light;

    this.flashMat = additive(sliverTex, PALETTE.sicklyLight);
    this.flash = new Mesh(plane, this.flashMat);
    this.flash.renderOrder = RENDER_ORDER.light + 1;
    this.flash.visible = false;

    this.gapShapeMat = new MeshBasicMaterial({
      map: gapShapeTexture(),
      color: PALETTE.nearBlack,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    this.gapShape = new Mesh(plane, this.gapShapeMat);
    this.gapShape.renderOrder = RENDER_ORDER.occluder;

    this.gapEyes = new GlowingEyes({ spacing: 0.056, size: 0.04, color: PALETTE.sickly });

    this.figureMat = new MeshBasicMaterial({
      map: figureTexture(),
      color: PALETTE.nearBlack,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    const body = new Mesh(plane, this.figureMat);
    body.scale.set(RUSH_FIGURE_W, RUSH_FIGURE_H, 1);
    body.renderOrder = RENDER_ORDER.rush;
    this.figureEyes = new GlowingEyes({
      spacing: 0.045,
      size: 0.034,
      color: PALETTE.sickly,
      renderOrder: RENDER_ORDER.rushGlow,
    });
    this.figureEyes.group.position.set(0, RUSH_EYE_Y, 0.01);
    this.figure = new Group();
    this.figure.add(body, this.figureEyes.group);
    this.figure.visible = false;

    this.root.add(this.sliver, this.wedge, this.flash, this.gapShape, this.gapEyes.group, this.figure);
  }

  available(ctx: FrameContext): boolean {
    return ctx.room.doors.length > 0;
  }

  isCountering(ctx: FrameContext): boolean {
    return ctx.hands.palmFacing(this.doorTarget) !== null;
  }

  begin(attack: AttackView, ctx: FrameContext): void {
    this.releaseAudio(0.05);
    this.placeFrame(ctx, pickRandom(ctx.room.doors));
    this.edgeSign = randSign();
    this.edgeX = this.edgeSign * (this.doorW / 2 - 0.012);
    this.fadeIn = 0;
    this.mSm = 0;
    this.push = 0;
    this.modeT = 0;
    this.mode = 'active';
    this.sync(attack);
    this.sliverMat.opacity = 0;
    this.wedgeMat.opacity = 0;
    this.flashMat.opacity = 0;
    this.gapShapeMat.opacity = 0;
    this.figure.visible = false;
    this.figureMat.opacity = 0;
    this.gapEyes.set(0);
    this.gapEyes.update(0);
    this.layoutGap(FX.sliverMinM);
    this.root.visible = true;

    this.root.localToWorld(this.voicePos.set(this.edgeX * 0.6, this.floorY + FX.voiceHeightM, 0.05));
    const input = this.voice.openAt(ctx.audio, this.voicePos, 'game');
    if (input) {
      this.knocks.start(ctx.audio.sounds.doorKnocks(input), 0.2);
      this.creak.start(ctx.audio.sounds.doorCreak(input), 0);
    }
  }

  update(attack: AttackView, _ctx: FrameContext): void {
    if (this.mode === 'active') this.sync(attack);
  }

  leave(ctx: FrameContext): void {
    if (this.mode !== 'active') return;
    this.mode = 'leaving';
    this.modeT = 0;
    this.startW = this.gapW;
    this.startOpacity = this.sliverMat.opacity;
    this.knocks.stop(0.2);
    this.creak.stop(0.6);
    const input = this.voice.input;
    if (input) ctx.audio.sounds.oneShot('doorRetreat', input);
    this.lingerLeft = CONFIG.threatFx.voiceLingerSec;
  }

  caught(ctx: FrameContext): void {
    if (!this.hasFrame || this.mode === 'idle') {
      this.placeFrame(ctx, pickRandom(ctx.room.doors));
      this.edgeX = this.edgeSign * (this.doorW / 2 - 0.012);
      this.layoutGap(FX.sliverMinM);
    }
    this.knocks.stop(0.05);
    this.creak.stop(0.1);
    this.voice.release(0.1);
    this.lingerLeft = 0;
    this.startW = this.gapW;
    this.mode = 'caught';
    this.modeT = 0;
    this.gapShapeMat.opacity = 0;
    this.gapEyes.set(0);
    this.gapEyes.update(0);
    this.rushStart.set(0, this.floorY + RUSH_FIGURE_H / 2, -0.15);
    this.figure.position.copy(this.rushStart);
    this.figure.visible = true;
    this.flash.visible = true;
    this.flashMat.opacity = 0;
    this.figureMat.opacity = 0;
    this.figureEyes.set(0);
    this.root.visible = true;

    this.root.localToWorld(this.tmpA.set(0, this.floorY + FX.voiceHeightM, 0.1));
    const input = this.overVoice.openAt(ctx.audio, this.tmpA, 'over');
    if (input) ctx.audio.sounds.oneShot('doorBurst', input, FX.doorBurstGain);
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
    if (this.hasFrame) {
      return this.root.localToWorld(out.set(this.edgeX - this.edgeSign * 0.3, this.floorY + 1.45, 0.3));
    }
    return pointInFrontOfHead(ctx.headPos, ctx.headForward, 0.8, 0.1, out);
  }

  reset(): void {
    this.releaseAudio(0.05);
    this.hideVisuals();
  }

  // ─── Per-mode animation ────────────────────────────────────────────────

  private tickActive(ctx: FrameContext, dt: number): void {
    const t = this.time;
    this.fadeIn = Math.min(1, this.fadeIn + dt / 0.8);
    this.mSm = damp(this.mSm, this.meter, 5, dt);
    this.push = damp(this.push, this.countering ? 1 : 0, 8, dt);
    const m = this.mSm;
    const push = this.push;

    // The door creeps open with the meter; a held palm shoves it back and it shudders.
    const tremble = 1 + push * 0.3 * jitter(t, 31, 19) + 0.05 * wobble(t * 3, 7);
    const w = Math.max(0.003, lerp(FX.sliverMinM, FX.sliverMaxM, m) * (1 - FX.pushBackNarrow * push) * tremble);
    this.layoutGap(w);

    // A failing bulb somewhere beyond the door.
    const flicker = 1 + 0.08 * jitter(t, 33, 9) - (jitter(t, 34, 2.5) > 0.86 ? 0.3 : 0);
    this.sliverMat.opacity = this.fadeIn * (0.45 + 0.45 * m) * flicker * (1 - 0.15 * push);
    this.wedgeMat.opacity = this.fadeIn * 0.3 * smoothstep(0.05, 0.6, m) * flicker;
    this.layoutWedge(w * 5 + 0.06, 0.3 + 1.5 * m);

    // Near a full meter, something is standing in the gap.
    this.gapShapeMat.opacity = smoothstep(0.45, 0.8, m) * 0.92 * (1 - 0.3 * push);
    const eyes = smoothstep(0.58, 0.85, m) * (1 - 0.6 * push) * (this.teaching ? 1.2 : 1);
    this.updateGapEyes(ctx, dt, eyes, 1 - 0.6 * push);

    // Rattle → knocking with urgency; the creak is how open the door is.
    const urgency = clamp01(0.2 + 0.8 * this.meter + Math.min(0.25, this.ageSec * 0.12));
    this.knocks.set(lerp(urgency, 0.1, push));
    this.creak.set(this.meter * lerp(1, 0.55, push));
  }

  private tickLeaving(ctx: FrameContext, dt: number): void {
    this.modeT += dt;
    const t = clamp01(this.modeT / FX.closeSec);
    const close = easeInCubic(t);
    const w = Math.max(0.0005, this.startW * (1 - close));
    this.layoutGap(w);
    this.sliverMat.opacity = this.startOpacity * (1 - smoothstep(0.6, 1, t));
    this.wedgeMat.opacity = damp(this.wedgeMat.opacity, 0, 6, dt);
    this.layoutWedge(w * 5 + 0.06, 0.3 + 1.5 * this.mSm * (1 - close));
    this.gapShapeMat.opacity = damp(this.gapShapeMat.opacity, 0, 10, dt);
    this.updateGapEyes(ctx, dt, 0, 0.3);
    if (t >= 1) this.hideVisuals();
  }

  private tickCaught(ctx: FrameContext, dt: number): void {
    this.modeT += dt;
    const t = this.modeT;

    // The door is flung open: the gap becomes the whole doorway, light floods out.
    const o = easeOutCubic(clamp01(t / 0.12));
    this.layoutGap(lerp(this.startW, this.doorW, o));
    this.sliverMat.opacity = 1;
    this.flash.position.set(0, -0.005, LIGHT_Z - 0.01);
    this.flash.scale.set(this.doorW * 1.1, this.doorH * 0.99, 1);
    this.flashMat.opacity = t < 0.06 ? t / 0.06 : lerp(1, 0.45, smoothstep(0.06, 0.6, t));
    this.layoutWedge(lerp(0.2, this.doorW * 1.8, o), lerp(0.4, 2.6, o));
    this.wedgeMat.opacity = 0.55 * o;

    // Something thin and dark comes out of the light, straight at the player.
    const u = clamp01((t - 0.06) / FX.rushSec);
    const e = u * u;
    pointInFrontOfHead(ctx.headPos, ctx.headForward, RUSH_FACE_DIST, -RUSH_EYE_Y, this.tmpB);
    this.root.worldToLocal(this.tmpA.copy(this.tmpB));
    this.figure.position.lerpVectors(this.rushStart, this.tmpA, e);
    this.root.localToWorld(this.tmpA.copy(this.figure.position));
    this.tmpB.set(ctx.headPos.x, this.tmpA.y, ctx.headPos.z);
    this.figure.lookAt(this.tmpB);
    this.figureMat.opacity = smoothstep(0, 0.08, t);
    this.figureEyes.set(smoothstep(0.1, 0.3, t));
    this.figureEyes.update(dt);
  }

  // ─── Helpers ───────────────────────────────────────────────────────────

  private sync(attack: AttackView): void {
    this.meter = attack.meter;
    this.countering = attack.countering;
    this.teaching = attack.teaching;
    this.ageSec = attack.ageSec;
  }

  /** Frame at the door's centre: +Z into the room, +Y up, floor at local floorY. */
  private placeFrame(ctx: FrameContext, door: RoomFeature | null): void {
    if (door) {
      this.doorW = Number.isFinite(door.width) ? clamp(door.width, 0.6, 1.3) : 0.85;
      this.doorH = Number.isFinite(door.height) ? clamp(door.height, 1.75, 2.4) : 2.0;
      // local-floor: the floor is y = 0. Trust the feature's centre unless its bottom is clearly off the floor.
      let cy = door.position.y;
      const bottom = cy - this.doorH / 2;
      if (bottom < -0.3 || bottom > 0.35) cy = this.doorH / 2;
      this.root.position.set(door.position.x, cy, door.position.z);
      orientToForward(this.root, door.normal);
      this.doorTarget.copy(door.position);
    } else {
      // Defensive only (available() needs a door): a door 2.5 m ahead.
      this.doorW = 0.85;
      this.doorH = 2;
      pointInFrontOfHead(ctx.headPos, ctx.headForward, 2.5, 0, this.tmpA);
      this.root.position.set(this.tmpA.x, 1, this.tmpA.z);
      this.tmpB.copy(ctx.headForward).multiplyScalar(-1);
      orientToForward(this.root, this.tmpB);
      this.doorTarget.copy(this.root.position);
    }
    this.floorY = -this.doorH / 2;
    this.root.updateMatrixWorld(true);
    this.hasFrame = true;
  }

  /** The gap opens from the frame edge toward the door's centre. */
  private layoutGap(w: number): void {
    this.gapW = w;
    this.sliverX = this.edgeX - (this.edgeSign * w) / 2;
    this.sliver.position.set(this.sliverX, -0.005, LIGHT_Z);
    this.sliver.scale.set(w, this.doorH * 0.97, 1);
    this.gapShape.position.set(this.sliverX, this.floorY + GAP_FIGURE_H / 2, LIGHT_Z + 0.005);
    this.gapShape.scale.set(w, GAP_FIGURE_H, 1);
  }

  private layoutWedge(width: number, length: number): void {
    this.wedge.position.set(this.sliverX, this.floorY + 0.004, length / 2 + 0.02);
    this.wedge.scale.set(width, length, 1);
  }

  private updateGapEyes(ctx: FrameContext, dt: number, intensity: number, squint: number): void {
    const g = this.gapEyes.group;
    g.position.set(this.sliverX, this.floorY + 1.62, LIGHT_Z + 0.012);
    g.lookAt(ctx.headPos);
    this.gapEyes.set(intensity, squint);
    this.gapEyes.update(dt);
  }

  private hideVisuals(): void {
    this.mode = 'idle';
    this.modeT = 0;
    this.meter = 0;
    this.countering = false;
    this.mSm = 0;
    this.push = 0;
    if (!this.root) return;
    this.root.visible = false;
    this.figure.visible = false;
    this.flash.visible = false;
    this.sliverMat.opacity = 0;
    this.wedgeMat.opacity = 0;
    this.flashMat.opacity = 0;
    this.gapShapeMat.opacity = 0;
    this.figureMat.opacity = 0;
    this.gapEyes.set(0);
    this.gapEyes.update(0);
    this.figureEyes.set(0);
    this.figureEyes.update(0);
  }

  private releaseAudio(fadeSec: number): void {
    this.knocks.stop(fadeSec);
    this.creak.stop(fadeSec);
    this.voice.release(fadeSec);
    this.overVoice.release(fadeSec);
    this.lingerLeft = 0;
  }
}
