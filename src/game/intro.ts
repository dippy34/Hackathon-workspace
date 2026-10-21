import {
  Mesh,
  MeshBasicMaterial,
  RingGeometry,
  Vector3,
  type World,
} from '@iwsdk/core';
import { CONFIG } from '../config.js';
import type { Desk, FeatureKind, FrameContext, HandState, TextCardLike } from './contracts.js';

type Step = 'calibrate' | 'calibrated' | 'placeWindow' | 'placeDoor' | 'done';

const CALIBRATE_TEXT_QUIET = 'Put both hands flat on your desk.\nStay quiet.';
const CALIBRATE_TEXT_NO_MIC = 'Put both hands flat on your desk.';

/**
 * The intro (DESIGN.md "The intro"): the calibration doubles as the tutorial.
 * While the player holds both hands flat and stays quiet it records the desk
 * height and the room's normal loudness. If the room scan found no window or
 * door, it then asks the player to point and pinch to place them.
 */
export class Intro {
  private step: Step = 'calibrate';
  private stepTime = 0;
  private holdSec = 0;
  private graceSec = 0;
  private calibratingMic = false;
  private readonly reticle: Mesh;
  private readonly point = new Vector3();
  private wasPinching = { left: false, right: false };

  constructor(
    world: World,
    private readonly text: TextCardLike,
    private readonly onDesk: (desk: Desk) => void,
    private readonly onDone: () => void,
  ) {
    this.reticle = new Mesh(
      new RingGeometry(0.06, 0.08, 40),
      new MeshBasicMaterial({ color: 0xd9cfbf, transparent: true, opacity: 0.85, depthTest: false, depthWrite: false }),
    );
    this.reticle.renderOrder = 900;
    this.reticle.visible = false;
    world.createTransformEntity(this.reticle, { persistent: true });
  }

  /** Human-readable step for the debug overlay. */
  get status(): string {
    if (this.step === 'calibrate') {
      return `calibrating ${Math.round((100 * this.holdSec) / CONFIG.intro.holdSec)}%`;
    }
    return this.step;
  }

  get done(): boolean {
    return this.step === 'done';
  }

  start(ctx: FrameContext): void {
    this.step = 'calibrate';
    this.stepTime = 0;
    this.holdSec = 0;
    this.graceSec = 0;
    this.calibratingMic = false;
    this.reticle.visible = false;
    this.text.show(ctx.mic.status === 'granted' ? CALIBRATE_TEXT_QUIET : CALIBRATE_TEXT_NO_MIC, { mode: 'gaze' });
  }

  /** Stop prompting (session ended mid-intro); start() begins again from calibration. */
  abort(): void {
    this.reticle.visible = false;
    this.text.hide(0);
  }

  update(ctx: FrameContext): void {
    this.stepTime += ctx.dt;
    switch (this.step) {
      case 'calibrate':
        this.updateCalibration(ctx);
        break;
      case 'calibrated':
        // Wait for the beat and for the room scan to have had a fair chance.
        if (this.stepTime >= CONFIG.intro.calibratedBeatSec && ctx.room.report.scanAgeSec >= CONFIG.intro.roomScanTimeoutSec) {
          this.nextPlacementStep(ctx);
        }
        break;
      case 'placeWindow':
        this.updatePlacement(ctx, 'window');
        break;
      case 'placeDoor':
        this.updatePlacement(ctx, 'door');
        break;
      case 'done':
        break;
    }
  }

  private updateCalibration(ctx: FrameContext): void {
    const { left, right } = ctx.hands;
    const ok =
      handReady(left, ctx.headPos) &&
      handReady(right, ctx.headPos) &&
      Math.abs(left.palm.y - right.palm.y) <= CONFIG.intro.handsLevelToleranceM;

    if (ok) {
      this.graceSec = 0;
      if (!this.calibratingMic) {
        ctx.mic.beginCalibration();
        this.calibratingMic = true;
      }
      this.holdSec += ctx.dt;
    } else if (this.holdSec > 0) {
      this.graceSec += ctx.dt;
      if (this.graceSec > CONFIG.intro.holdGraceSec) {
        this.holdSec = 0;
        this.calibratingMic = false; // the next beginCalibration() restarts the room-level sample
      }
    }

    const progress = Math.min(1, this.holdSec / CONFIG.intro.holdSec);
    this.text.show(ctx.mic.status === 'granted' ? CALIBRATE_TEXT_QUIET : CALIBRATE_TEXT_NO_MIC, {
      mode: 'gaze',
      subtitle: progress > 0 ? progressDots(progress) : undefined,
      fadeInSec: 0,
    });

    if (this.holdSec >= CONFIG.intro.holdSec) {
      const center = new Vector3().addVectors(left.palm, right.palm).multiplyScalar(0.5);
      const towardPlayer = new Vector3(ctx.headPos.x - center.x, 0, ctx.headPos.z - center.z);
      if (towardPlayer.lengthSq() < 1e-6) towardPlayer.set(0, 0, 1);
      towardPlayer.normalize();
      this.onDesk({ height: center.y, center, towardPlayer });
      ctx.mic.endCalibration();
      this.calibratingMic = false;
      ctx.audio.sounds.oneShot('calibrated', ctx.audio.gameBus);
      this.text.show('Good.', { mode: 'gaze', fadeInSec: 0.2 });
      this.setStep('calibrated');
    }
  }

  private nextPlacementStep(ctx: FrameContext): void {
    if (ctx.room.windows.length === 0) {
      this.setStep('placeWindow');
      this.text.show('No window found.\nPoint at a window, or any wall,\nand pinch.', { mode: 'gaze' });
    } else if (ctx.room.doors.length === 0) {
      this.setStep('placeDoor');
      this.text.show('No door found.\nPoint at your door and pinch.', { mode: 'gaze' });
    } else {
      this.finish();
    }
  }

  private updatePlacement(ctx: FrameContext, kind: FeatureKind): void {
    const hand = this.aimingHand(ctx);
    if (!hand) {
      this.reticle.visible = false;
    } else {
      ctx.room.placementPoint(hand.aimOrigin, hand.aimDir, this.point);
      this.reticle.visible = true;
      this.reticle.position.copy(this.point);
      this.reticle.lookAt(ctx.headPos);
    }

    // Place on a fresh pinch (a rising edge), after a short settle so the
    // pinch that confirmed nothing earlier doesn't place instantly.
    const pinched = this.risingPinch(ctx);
    if (pinched && hand && this.stepTime > CONFIG.intro.placementSettleSec) {
      ctx.room.place(kind, this.point, ctx.headPos);
      ctx.audio.sounds.oneShot('placed', ctx.audio.gameBus);
      this.reticle.visible = false;
      if (kind === 'window' && ctx.room.doors.length === 0) {
        this.setStep('placeDoor');
        this.text.show('Now point at your door and pinch.', { mode: 'gaze' });
      } else {
        this.finish();
      }
    }
  }

  /** The hand to aim with: the pinching one, else the one pointing most forward. */
  private aimingHand(ctx: FrameContext): HandState | null {
    const { left, right } = ctx.hands;
    if (right.tracked && right.pinching) return right;
    if (left.tracked && left.pinching) return left;
    if (right.tracked && left.tracked) {
      return right.aimDir.dot(ctx.headForward) >= left.aimDir.dot(ctx.headForward) ? right : left;
    }
    if (right.tracked) return right;
    if (left.tracked) return left;
    return null;
  }

  private risingPinch(ctx: FrameContext): boolean {
    const l = ctx.hands.left.pinching;
    const r = ctx.hands.right.pinching;
    const rising = (l && !this.wasPinching.left) || (r && !this.wasPinching.right);
    this.wasPinching.left = l;
    this.wasPinching.right = r;
    return rising;
  }

  private finish(): void {
    this.reticle.visible = false;
    this.text.hide(0.6);
    this.setStep('done');
    this.onDone();
  }

  private setStep(step: Step): void {
    this.step = step;
    this.stepTime = 0;
  }
}

/** Tracked, palm facing down, resting below the head, and still. */
function handReady(h: HandState, headPos: Vector3): boolean {
  return (
    h.tracked &&
    h.palmDownAngleDeg <= CONFIG.hands.flatPalmDownMaxAngleDeg &&
    h.speed <= CONFIG.intro.stillMaxSpeedMps &&
    h.palm.y < headPos.y - CONFIG.intro.minPalmBelowHeadM
  );
}

function progressDots(p: number): string {
  const n = 5;
  const filled = Math.round(p * n);
  return '● '.repeat(filled) + '○ '.repeat(n - filled);
}
