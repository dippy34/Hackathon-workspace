/**
 * Hold Still's sound bank: every sound is procedural Web Audio (M1 has no
 * audio files). Each sound is its own small function or class so the human
 * can swap in recordings one by one in M2:
 *
 *   loops     -> src/audio/loops.ts    (ambience, scratching, glassTaps,
 *                                      doorKnocks, doorCreak, ringing, heartbeat)
 *   one-shots -> src/audio/oneshots.ts (lightsOut ... doorBurst)
 *   shared    -> src/audio/voices.ts   (creak, squeak, drag, breath, throat)
 *                src/audio/buffers.ts  (noise beds + pre-rendered transients)
 *                src/audio/kit.ts      (lookahead clock, node groups, Loop base)
 *
 * Every sound connects to the `out` node it is given (a SpatialVoice input
 * or a bus); levels are balanced in CONFIG.audio.loopLevels / oneShotLevels.
 */

import { CONFIG } from '../config.js';
import type { LoopHandle, OneShot, SoundBank } from '../game/contracts.js';
import { Kit } from './kit.js';
import {
  ambienceLoop,
  doorCreakLoop,
  doorKnocksLoop,
  glassTapsLoop,
  heartbeatLoop,
  ringingLoop,
  scratchingLoop,
} from './loops.js';
import { ONE_SHOTS } from './oneshots.js';

export interface ProceduralSoundBank extends SoundBank {
  /**
   * Run the lookahead scheduler now. Allocation-free; the AudioEngine calls
   * it every frame (from updateListener) so rhythms stay tight even if the
   * browser throttles the scheduler's timer.
   */
  pump(): void;
  /** Fade out every running loop (night restart / ending safety net). */
  stopAll(fadeSec?: number): void;
  /** Running loops (debug). */
  readonly loopCount: number;
  /** Live transient sound events (debug / CPU guard). */
  readonly liveEvents: number;
}

export function createSoundBank(ctx: AudioContext): ProceduralSoundBank {
  const k = new Kit(ctx);
  const levels = CONFIG.audio.oneShotLevels;

  return {
    ambience: (out: AudioNode): LoopHandle => ambienceLoop(k, out),
    scratching: (out: AudioNode): LoopHandle => scratchingLoop(k, out),
    glassTaps: (out: AudioNode): LoopHandle => glassTapsLoop(k, out),
    doorKnocks: (out: AudioNode): LoopHandle => doorKnocksLoop(k, out),
    doorCreak: (out: AudioNode): LoopHandle => doorCreakLoop(k, out),
    ringing: (out: AudioNode): LoopHandle => ringingLoop(k, out),
    heartbeat: (out: AudioNode): LoopHandle => heartbeatLoop(k, out),

    oneShot(name: OneShot, out: AudioNode, gain = 1): void {
      // A suspended context would queue the sound and play it late, all at once.
      if (ctx.state !== 'running') return;
      const fn = ONE_SHOTS[name];
      if (!fn) return;
      try {
        fn(k, out, ctx.currentTime + 0.01, gain * levels[name]);
      } catch (err) {
        console.warn('[audio] one-shot failed', name, err);
      }
    },

    pump(): void {
      k.clock.pump();
    },

    stopAll(fadeSec = 0.3): void {
      for (const loop of Array.from(k.loops)) loop.stop(fadeSec);
    },

    get loopCount(): number {
      return k.loops.size;
    },

    get liveEvents(): number {
      return k.live;
    },
  };
}
