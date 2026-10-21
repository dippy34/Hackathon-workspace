/**
 * Hold Still's audio engine: our OWN DOM AudioContext (IWSDK suspends its
 * shared three.js context when an XR session ends; we keep control of ours).
 *
 *   sounds ─┬─> gameBus (masterGain; the Listener cuts it to 0) ─┐
 *           │      └─> analyser (gameOutputLevel, debug)          ├─> master ─> limiter ─> speakers
 *           └─> overBus (masterGain; ringing, caught screams) ────┘
 *
 * Spatial voices are HRTF PannerNodes in world space; updateListener() copies
 * the head pose into ctx.listener every frame (and pumps the sound
 * scheduler). Nothing here allocates per frame.
 *
 * NOTE: never import `AudioContext` / `Audio` from '@iwsdk/core' in this
 * folder (three's helpers shadow the DOM classes).
 */

import type { Object3D, Vector3 } from '@iwsdk/core';
import { CONFIG } from '../config.js';
import type { AudioEngineLike, SpatialVoice } from '../game/contracts.js';
import { holdParam, rampParam } from './kit.js';
import { createSoundBank, type ProceduralSoundBank } from './sounds.js';

/** Moves larger than this (m) snap instead of gliding (no audible pan sweep on a teleport). */
const SNAP_DIST_SQ = 0.5 * 0.5;
/** Pose changes below these are ignored (no automation churn while still). */
const POS_EPS = 0.001;
const DIR_EPS = 0.001;

function setParam(p: AudioParam, v: number, t: number, tc: number, snap: boolean): void {
  if (snap) {
    p.cancelScheduledValues(t);
    p.setValueAtTime(v, t);
  } else {
    p.setTargetAtTime(v, t, tc);
  }
}

class Voice implements SpatialVoice {
  readonly input: GainNode;
  private readonly panner: PannerNode;
  private disposed = false;
  private x: number;
  private y: number;
  private z: number;

  constructor(
    private readonly ctx: AudioContext,
    p: Vector3,
    dest: AudioNode,
    refDistance: number,
  ) {
    this.x = p.x;
    this.y = p.y;
    this.z = p.z;
    this.panner = new PannerNode(ctx, {
      panningModel: 'HRTF',
      distanceModel: 'inverse',
      refDistance: Math.max(0.05, refDistance),
      rolloffFactor: CONFIG.audio.voiceRolloff,
      maxDistance: 100,
      positionX: p.x,
      positionY: p.y,
      positionZ: p.z,
    });
    this.input = new GainNode(ctx, { gain: 1 });
    this.input.connect(this.panner);
    this.panner.connect(dest);
  }

  setPosition(p: Vector3): void {
    if (this.disposed) return;
    const dx = p.x - this.x;
    const dy = p.y - this.y;
    const dz = p.z - this.z;
    if (Math.abs(dx) < POS_EPS && Math.abs(dy) < POS_EPS && Math.abs(dz) < POS_EPS) return;
    this.x = p.x;
    this.y = p.y;
    this.z = p.z;
    const pn = this.panner;
    if (pn.positionX) {
      const t = this.ctx.currentTime;
      const tc = CONFIG.audio.poseSmoothingSec;
      const snap = dx * dx + dy * dy + dz * dz > SNAP_DIST_SQ;
      setParam(pn.positionX, p.x, t, tc, snap);
      setParam(pn.positionY, p.y, t, tc, snap);
      setParam(pn.positionZ, p.z, t, tc, snap);
    } else {
      pn.setPosition(p.x, p.y, p.z);
    }
  }

  /** Quick 30 ms fade, then disconnect. Stop loops feeding it first (their fade needs the voice alive). */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      rampParam(this.input.gain, 0, this.ctx.currentTime, 0.03);
    } catch {
      /* closed context */
    }
    setTimeout(() => {
      try {
        this.input.disconnect();
        this.panner.disconnect();
      } catch {
        /* already disconnected */
      }
    }, 80);
  }
}

export class AudioEngine implements AudioEngineLike {
  readonly ctx: AudioContext;
  readonly gameBus: GainNode;
  readonly overBus: GainNode;
  readonly master: GainNode;
  readonly sounds: ProceduralSoundBank;
  private readonly limiter: DynamicsCompressorNode;
  private readonly analyser: AnalyserNode;
  private readonly levelBuf: Float32Array<ArrayBuffer>;
  private cut = false;
  /** Resume automatically if the browser suspends us after we've started. */
  private wantRunning = false;
  /** Last listener pose written: px py pz fx fy fz ux uy uz (NaN = never). */
  private readonly pose = new Float64Array(9).fill(NaN);

  constructor() {
    const ctx = new AudioContext({ latencyHint: 'interactive' });
    this.ctx = ctx;

    this.limiter = new DynamicsCompressorNode(ctx, {
      threshold: CONFIG.audio.limiterThresholdDb,
      knee: 0,
      ratio: 20,
      attack: 0.002,
      release: 0.15,
    });
    this.limiter.connect(ctx.destination);
    this.master = new GainNode(ctx, { gain: 1 });
    this.master.connect(this.limiter);

    this.gameBus = new GainNode(ctx, { gain: CONFIG.audio.masterGain });
    this.overBus = new GainNode(ctx, { gain: CONFIG.audio.masterGain });
    this.gameBus.connect(this.master);
    this.overBus.connect(this.master);

    this.analyser = new AnalyserNode(ctx, { fftSize: 1024, smoothingTimeConstant: 0 });
    this.gameBus.connect(this.analyser);
    this.levelBuf = new Float32Array(this.analyser.fftSize);

    ctx.addEventListener('statechange', () => {
      if (this.wantRunning && ctx.state === 'suspended') ctx.resume().catch(() => {});
    });

    this.sounds = createSoundBank(ctx);
  }

  get gameCut(): boolean {
    return this.cut;
  }

  createVoice(position: Vector3, bus: 'game' | 'over' = 'game', refDistance: number = CONFIG.audio.voiceRefDistanceM): SpatialVoice {
    return new Voice(this.ctx, position, bus === 'over' ? this.overBus : this.gameBus, refDistance);
  }

  setGameCut(cut: boolean): void {
    if (cut === this.cut) return;
    this.cut = cut;
    rampParam(this.gameBus.gain, cut ? 0 : CONFIG.audio.masterGain, this.ctx.currentTime, CONFIG.audio.listenerCutSec);
  }

  gameOutputLevel(): number {
    const b = this.levelBuf;
    this.analyser.getFloatTimeDomainData(b);
    let s = 0;
    for (let i = 0; i < b.length; i++) s += b[i] * b[i];
    return Math.sqrt(s / b.length);
  }

  /** Never throws. Calls ctx.resume() synchronously, so it keeps a click's user activation. */
  async resume(): Promise<void> {
    const state = this.ctx.state as string;
    if (state === 'closed') return;
    this.wantRunning = true;
    if (state === 'running') return;
    try {
      await this.ctx.resume();
    } catch (err) {
      console.warn('[audio] resume failed', err);
    }
  }

  updateListener(head: Object3D): void {
    this.sounds.pump();

    head.updateWorldMatrix(true, false);
    const e = head.matrixWorld.elements;
    const px = e[12];
    const py = e[13];
    const pz = e[14];
    // Forward = -Z column, up = +Y column (normalised in case the rig is scaled).
    let fx = -e[8];
    let fy = -e[9];
    let fz = -e[10];
    let ux = e[4];
    let uy = e[5];
    let uz = e[6];
    const fl = Math.sqrt(fx * fx + fy * fy + fz * fz) || 1;
    fx /= fl;
    fy /= fl;
    fz /= fl;
    const ul = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1;
    ux /= ul;
    uy /= ul;
    uz /= ul;

    const q = this.pose;
    const first = q[0] !== q[0];
    if (
      !first &&
      Math.abs(px - q[0]) < POS_EPS &&
      Math.abs(py - q[1]) < POS_EPS &&
      Math.abs(pz - q[2]) < POS_EPS &&
      Math.abs(fx - q[3]) < DIR_EPS &&
      Math.abs(fy - q[4]) < DIR_EPS &&
      Math.abs(fz - q[5]) < DIR_EPS &&
      Math.abs(ux - q[6]) < DIR_EPS &&
      Math.abs(uy - q[7]) < DIR_EPS &&
      Math.abs(uz - q[8]) < DIR_EPS
    ) {
      return;
    }
    const dx = px - q[0];
    const dy = py - q[1];
    const dz = pz - q[2];
    const snap = first || dx * dx + dy * dy + dz * dz > SNAP_DIST_SQ;
    q[0] = px;
    q[1] = py;
    q[2] = pz;
    q[3] = fx;
    q[4] = fy;
    q[5] = fz;
    q[6] = ux;
    q[7] = uy;
    q[8] = uz;

    const l = this.ctx.listener;
    if (l.positionX) {
      const t = this.ctx.currentTime;
      const tc = CONFIG.audio.poseSmoothingSec;
      setParam(l.positionX, px, t, tc, snap);
      setParam(l.positionY, py, t, tc, snap);
      setParam(l.positionZ, pz, t, tc, snap);
      setParam(l.forwardX, fx, t, tc, first);
      setParam(l.forwardY, fy, t, tc, first);
      setParam(l.forwardZ, fz, t, tc, first);
      setParam(l.upX, ux, t, tc, first);
      setParam(l.upY, uy, t, tc, first);
      setParam(l.upZ, uz, t, tc, first);
    } else {
      l.setPosition(px, py, pz);
      l.setOrientation(fx, fy, fz, ux, uy, uz);
    }
  }

  /** Fade out every running loop (safety net for night restarts / the ending). */
  stopAll(fadeSec = 0.3): void {
    this.sounds.stopAll(fadeSec);
  }

  /** Tear the context down (not needed during normal play). */
  async close(): Promise<void> {
    this.wantRunning = false;
    this.sounds.stopAll(0);
    try {
      holdParam(this.master.gain, this.ctx.currentTime);
      await this.ctx.close();
    } catch {
      /* already closed */
    }
  }
}
