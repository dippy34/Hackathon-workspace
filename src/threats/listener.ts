/**
 * The Listener (DESIGN.md). Counter (LOCKED): stay quiet (the mic is not noisy).
 *
 * It is never seen. Its warning IS the silence: every game sound cuts out
 * (which also keeps the mic from hearing the game), leaving a faint ringing
 * on the over-bus that rises only very slightly with the meter.
 * Leave: the room sound comes back, listenerLeave on the game bus (through a
 * private gain, so reset() can still cut it off).
 * Caught: the room sound comes back with a scream right next to one ear
 * (a spatial over-bus voice ~0.12 m beside the head, left or right at random,
 * following the head while it plays).
 *
 * Onset grace: for audio.listenerCutSec + threatFx.listener.onsetGraceSec
 * after it arrives, the mic is ignored (counts as quiet). The game's own sound
 * is still fading out of the speakers then (plus output latency and the mic's
 * smoothing), and with echo cancellation off the mic hears it; that must
 * never read as the player making noise.
 */

import { Vector3, type World } from '@iwsdk/core';
import { CONFIG } from '../config.js';
import type { AttackView } from '../core/types.js';
import type { AudioEngineLike, FrameContext, ThreatPresenter } from '../game/contracts.js';
import { BusSlot, LoopSlot, VoiceSlot, headRight, lerp, pointInFrontOfHead, randSign } from './common.js';

const FX = CONFIG.threatFx.listener;

export class ListenerThreat implements ThreatPresenter {
  readonly id = 'listener' as const;
  readonly teachingHint = 'Shh. Not a sound.';

  private audio: AudioEngineLike | null = null;
  private readonly ringing = new LoopSlot();
  private readonly scream = new VoiceSlot();
  /** Owns the listenerLeave one-shot so reset() can stop it. */
  private readonly leaveSound = new BusSlot();
  private active = false;
  private screamLeft = 0;
  /** Seconds left in which the mic is ignored (the game's own sound is still fading). */
  private onsetLeft = 0;
  /** Seconds until leaveSound is released (its one-shot has finished). */
  private leaveLingerLeft = 0;
  private side: 1 | -1 = 1;
  private readonly right = new Vector3();
  private readonly ear = new Vector3();

  init(_world: World): void {
    // Nothing to see: the Listener stays unseen.
  }

  available(ctx: FrameContext): boolean {
    return ctx.mic.status === 'granted' && ctx.mic.baseline !== null;
  }

  isCountering(ctx: FrameContext): boolean {
    // Counter (LOCKED): stay quiet. The grace only discounts the game's own fade-out.
    return this.onsetLeft > 0 || !ctx.mic.noisy;
  }

  begin(_attack: AttackView, ctx: FrameContext): void {
    this.audio = ctx.audio;
    this.scream.release(0.05);
    this.screamLeft = 0;
    this.releaseLeaveSound(0.05);
    this.onsetLeft = CONFIG.audio.listenerCutSec + FX.onsetGraceSec;
    ctx.audio.setGameCut(true);
    this.ringing.start(ctx.audio.sounds.ringing(ctx.audio.overBus), FX.ringingMin);
    this.active = true;
  }

  update(attack: AttackView, _ctx: FrameContext): void {
    if (!this.active) return;
    this.ringing.set(lerp(FX.ringingMin, FX.ringingMax, attack.meter));
  }

  leave(ctx: FrameContext): void {
    if (!this.active) return;
    this.active = false;
    this.onsetLeft = 0;
    ctx.audio.setGameCut(false);
    this.ringing.stop(0.6);
    const input = this.leaveSound.openOn(ctx.audio, 'game');
    if (input) {
      ctx.audio.sounds.oneShot('listenerLeave', input);
      this.leaveLingerLeft = CONFIG.threatFx.voiceLingerSec;
    }
  }

  caught(ctx: FrameContext): void {
    this.audio = ctx.audio;
    this.active = false;
    this.onsetLeft = 0;
    this.releaseLeaveSound(0.05);
    ctx.audio.setGameCut(false);
    this.ringing.stop(0.03);
    this.side = randSign();
    this.earPoint(ctx, this.ear);
    const input = this.scream.openAt(ctx.audio, this.ear, 'over', FX.screamOffsetM);
    if (input) ctx.audio.sounds.oneShot('scream', input, FX.screamGain);
    this.screamLeft = FX.screamFollowSec;
  }

  tick(ctx: FrameContext): void {
    const dt = Math.min(ctx.dt, 0.1);
    // Real (frame) time, not game time: the fade-out it covers runs on the audio clock.
    if (this.onsetLeft > 0) this.onsetLeft -= dt;
    if (this.leaveLingerLeft > 0 && (this.leaveLingerLeft -= dt) <= 0) this.releaseLeaveSound(0.25);
    if (this.screamLeft <= 0) return;
    this.screamLeft -= dt;
    // Stay at the ear even if the player jerks away.
    this.earPoint(ctx, this.ear);
    this.scream.setPosition(this.ear);
    if (this.screamLeft <= 0) this.scream.release(0.3);
  }

  hintAnchor(ctx: FrameContext, out: Vector3): Vector3 {
    return pointInFrontOfHead(ctx.headPos, ctx.headForward, 0.6, 0, out);
  }

  reset(): void {
    this.audio?.setGameCut(false);
    this.ringing.stop(0.05);
    this.scream.release(0.05);
    this.screamLeft = 0;
    this.releaseLeaveSound(0.05);
    this.onsetLeft = 0;
    this.active = false;
  }

  private releaseLeaveSound(fadeSec: number): void {
    this.leaveSound.release(fadeSec);
    this.leaveLingerLeft = 0;
  }

  private earPoint(ctx: FrameContext, out: Vector3): Vector3 {
    headRight(ctx.head, this.right);
    return out.copy(ctx.headPos).addScaledVector(this.right, this.side * FX.screamOffsetM);
  }
}
