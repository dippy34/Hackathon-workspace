/**
 * Hand tracking from raw WebXR joint poses: palm position and normal, pinch,
 * aim ray, flat-on-the-desk and palm-facing tests.
 *
 * Tracking loss (BUILD_SPEC "Hands"): a hand that is not tracked this frame
 * keeps every last value (palm, flat, pinching, ...) and only `tracked` goes
 * false, so a hand that drops out while pressed on the desk still counts.
 */

import { Matrix4, Vector3, type World } from '@iwsdk/core';
import { CONFIG } from '../config.js';
import type { Desk, HandState, HandTrackerLike, Side } from '../game/contracts.js';

const RAD2DEG = 180 / Math.PI;
const DEG2RAD = Math.PI / 180;

class Hand implements HandState {
  tracked = false;
  seen = false;
  readonly palm = new Vector3();
  readonly palmNormal = new Vector3(0, -1, 0);
  readonly pinchPoint = new Vector3();
  readonly aimOrigin = new Vector3();
  readonly aimDir = new Vector3(0, 0, -1);
  pinchDistance = Infinity;
  pinching = false;
  speed = 0;
  palmDownAngleDeg = 180;
  heightAboveDesk = NaN;
  flat = false;
  /** Palm position on the previous tracked frame (for speed); invalid after a tracking gap. */
  readonly prevPalm = new Vector3();
  prevValid = false;

  constructor(readonly side: Side) {}

  /** Re-derive the desk-relative values from the current palm (also used by setDesk). */
  applyDesk(desk: Desk | null): void {
    if (!desk || !this.seen) {
      this.heightAboveDesk = NaN;
      this.flat = false;
      return;
    }
    this.heightAboveDesk = this.palm.y - desk.height;
    this.flat =
      Math.abs(this.heightAboveDesk) <= CONFIG.hands.flatHeightToleranceM &&
      this.palmDownAngleDeg <= CONFIG.hands.flatPalmDownMaxAngleDeg;
  }
}

export class HandTracker implements HandTrackerLike {
  readonly left = new Hand('left');
  readonly right = new Hand('right');
  private desk: Desk | null = null;

  // Scratch (no per-frame allocation).
  private readonly playerMat = new Matrix4();
  private readonly jointMat = new Matrix4();
  private readonly rayMat = new Matrix4();
  private readonly thumbTip = new Vector3();
  private readonly indexTip = new Vector3();
  private readonly toTarget = new Vector3();

  constructor(private readonly world: World) {}

  get bothFlat(): boolean {
    return this.left.flat && this.right.flat;
  }

  setDesk(desk: Desk | null): void {
    this.desk = desk;
    this.left.applyDesk(desk);
    this.right.applyDesk(desk);
  }

  update(frame: XRFrame, refSpace: XRReferenceSpace, dt: number): void {
    this.left.tracked = false;
    this.right.tracked = false;
    // Reference space -> world (the rig sits at the origin, but stay correct if it moves).
    this.playerMat.copy(this.world.player.matrixWorld);

    const sources = frame.session.inputSources;
    for (let i = 0; i < sources.length; i++) {
      const source = sources[i];
      if (!source.hand) continue;
      const hand =
        source.handedness === 'left' ? this.left : source.handedness === 'right' ? this.right : null;
      if (hand && !hand.tracked) this.sample(hand, source, source.hand, frame, refSpace, dt);
    }
    // Don't turn a tracking gap into a speed spike.
    if (!this.left.tracked) this.left.prevValid = false;
    if (!this.right.tracked) this.right.prevValid = false;
  }

  palmFacing(target: Vector3): Side | null {
    const minDot = Math.cos(CONFIG.hands.palmFacingMaxAngleDeg * DEG2RAD);
    const l = this.facingDot(this.left, target);
    const r = this.facingDot(this.right, target);
    if (l < minDot && r < minDot) return null;
    return l >= r ? 'left' : 'right';
  }

  /** cos(angle) between a hand's palm normal and the palm->target direction; -Infinity if it can't count. */
  private facingDot(hand: Hand, target: Vector3): number {
    if (!hand.seen) return -Infinity;
    // Palm held out, not resting on the desk (skip the height test until calibrated).
    if (this.desk && !(hand.heightAboveDesk >= CONFIG.hands.palmOutMinAboveDeskM)) return -Infinity;
    const d = this.toTarget.subVectors(target, hand.palm);
    const len = d.length();
    if (len < 1e-4) return -Infinity;
    return d.dot(hand.palmNormal) / len;
  }

  /** Read one hand's joints; leaves the hand untouched (last state) if any joint is missing. */
  private sample(
    hand: Hand,
    source: XRInputSource,
    xrHand: XRHand,
    frame: XRFrame,
    refSpace: XRReferenceSpace,
    dt: number,
  ): void {
    const wristSpace = xrHand.get('wrist');
    const palmSpace = xrHand.get('middle-finger-metacarpal');
    const thumbSpace = xrHand.get('thumb-tip');
    const indexSpace = xrHand.get('index-finger-tip');
    if (!wristSpace || !palmSpace || !thumbSpace || !indexSpace || !frame.getJointPose) return;
    // The wrist is only a tracking check: all four joints must be valid this frame.
    const wrist = frame.getJointPose(wristSpace, refSpace);
    const palm = frame.getJointPose(palmSpace, refSpace);
    const thumb = frame.getJointPose(thumbSpace, refSpace);
    const index = frame.getJointPose(indexSpace, refSpace);
    if (!wrist || !palm || !thumb || !index) return;

    hand.tracked = true;
    hand.seen = true;

    // Palm: middle-finger metacarpal. Joint -Y points out of the palm, -Z along the bone.
    const m = this.jointMat.fromArray(palm.transform.matrix).premultiply(this.playerMat).elements;
    hand.palm.set(m[12], m[13], m[14]);
    hand.palmNormal.set(-m[4], -m[5], -m[6]).normalize();
    hand.palmDownAngleDeg = Math.acos(Math.min(1, Math.max(-1, -hand.palmNormal.y))) * RAD2DEG;

    // Speed (smoothed), skipping the first frame after a tracking gap.
    if (hand.prevValid && dt > 0) {
      const v = hand.palm.distanceTo(hand.prevPalm) / dt;
      hand.speed += (v - hand.speed) * (1 - Math.exp(-dt / CONFIG.hands.speedSmoothingSec));
    }
    hand.prevPalm.copy(hand.palm);
    hand.prevValid = true;

    // Pinch with hysteresis.
    const t = thumb.transform.position;
    const ix = index.transform.position;
    this.thumbTip.set(t.x, t.y, t.z).applyMatrix4(this.playerMat);
    this.indexTip.set(ix.x, ix.y, ix.z).applyMatrix4(this.playerMat);
    hand.pinchDistance = this.thumbTip.distanceTo(this.indexTip);
    hand.pinchPoint.addVectors(this.thumbTip, this.indexTip).multiplyScalar(0.5);
    if (hand.pinching) {
      if (hand.pinchDistance > CONFIG.hands.pinchEndM) hand.pinching = false;
    } else if (hand.pinchDistance < CONFIG.hands.pinchStartM) {
      hand.pinching = true;
    }

    // Aim: from the pinch (where a held flashlight sits) along the target ray,
    // falling back to the metacarpal's forward (-Z) axis.
    hand.aimOrigin.copy(hand.pinchPoint);
    const ray = frame.getPose(source.targetRaySpace, refSpace);
    if (ray) {
      const r = this.rayMat.fromArray(ray.transform.matrix).premultiply(this.playerMat).elements;
      hand.aimDir.set(-r[8], -r[9], -r[10]).normalize();
    } else {
      hand.aimDir.set(-m[8], -m[9], -m[10]).normalize();
    }

    hand.applyDesk(this.desk);
  }
}
