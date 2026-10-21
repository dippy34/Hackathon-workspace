/**
 * Contracts between the presentation modules (senses, audio, fx, threats,
 * debug) and the game director (src/game/director.ts). Every module is built
 * against these interfaces so they can be developed independently.
 *
 * Coordinates: everything is in WORLD space (metres, +Y up). With locomotion
 * off the player rig stays at the origin, but always convert reference-space
 * poses with world.player.matrixWorld to be safe.
 */

import type { Object3D, Vector3, World } from '@iwsdk/core';
import type { ThreatId } from '../config.js';
import type { AttackView, NightRunnerLike, Phase } from '../core/types.js';

export type Side = 'left' | 'right';

// ─── Hands ────────────────────────────────────────────────────────────────

export interface HandState {
  readonly side: Side;
  /** Joint poses were available this frame. */
  tracked: boolean;
  /** Has been tracked at least once this session (values below are meaningful). */
  seen: boolean;
  /** Palm centre (middle-finger-metacarpal joint). Last known value while untracked. */
  readonly palm: Vector3;
  /** Unit vector out of the palm (the joint's -Y axis). */
  readonly palmNormal: Vector3;
  /** Midpoint between thumb tip and index tip. */
  readonly pinchPoint: Vector3;
  /** Aim ray origin + unit direction (hand target-ray space; falls back to hand forward). */
  readonly aimOrigin: Vector3;
  readonly aimDir: Vector3;
  /** Thumb-tip to index-tip distance (m). */
  pinchDistance: number;
  /** Pinch with hysteresis (CONFIG.hands.pinchStartM / pinchEndM). Held while untracked, for up to CONFIG.hands.pinchLostGraceSec. */
  pinching: boolean;
  /** Smoothed palm speed (m/s). */
  speed: number;
  /** Angle (deg) between palmNormal and straight down. */
  palmDownAngleDeg: number;
  /** Palm height minus calibrated desk height (m); NaN until calibrated. */
  heightAboveDesk: number;
  /** "Flat on the desk" per DESIGN.md (needs desk calibration). Held while untracked. */
  flat: boolean;
}

export interface HandsState {
  readonly left: HandState;
  readonly right: HandState;
  /** Both hands flat (Under the Desk counter). */
  readonly bothFlat: boolean;
}

export interface HandTrackerLike extends HandsState {
  /** Call once per frame inside the XR frame (frame/refSpace from IWSDK). */
  update(frame: XRFrame, refSpace: XRReferenceSpace, dt: number): void;
  /** Set/replace the desk calibration used for `flat`. */
  setDesk(desk: Desk | null): void;
  /** Palm-out test for the Knocker: is either hand's palm facing `target` (world)? */
  palmFacing(target: Vector3): Side | null;
}

// ─── Desk + room ──────────────────────────────────────────────────────────

export interface Desk {
  /** Calibrated palm height when flat on the desk (world Y, m). */
  height: number;
  /** Midpoint between the two calibrated palms (on the desk). */
  readonly center: Vector3;
  /** Horizontal unit vector from the desk centre toward the player's body. */
  readonly towardPlayer: Vector3;
}

export type FeatureKind = 'window' | 'door';

export interface RoomFeature {
  readonly kind: FeatureKind;
  /** Centre of the window/door opening. */
  readonly position: Vector3;
  /** Horizontal unit normal pointing INTO the room (toward the player). */
  readonly normal: Vector3;
  width: number;
  height: number;
  source: 'plane' | 'mesh' | 'placed';
  /** Raw semantic label (or 'placed'). */
  label: string;
}

export interface RoomScanReport {
  planeDetection: boolean;
  meshDetection: boolean;
  planeCount: number;
  meshCount: number;
  /** label -> count, every label the headset reported ('(none)' for null/empty). */
  planeLabels: Record<string, number>;
  meshLabels: Record<string, number>;
  /** Seconds since the scan started. */
  scanAgeSec: number;
}

export interface RoomScannerLike {
  readonly windows: readonly RoomFeature[];
  readonly doors: readonly RoomFeature[];
  readonly report: RoomScanReport;
  /** Call every frame during the session; logs new labels to the console once each. */
  update(frame: XRFrame, refSpace: XRReferenceSpace, dt: number): void;
  /**
   * Fallback placement: where would a feature land along this aim ray?
   * Hits detected vertical planes, else CONFIG.intro.placementFallbackDistM.
   */
  placementPoint(origin: Vector3, dir: Vector3, out: Vector3): Vector3;
  /** Add a manually placed window/door (normal faces `towardPoint`, usually the head). */
  place(kind: FeatureKind, position: Vector3, towardPoint: Vector3): RoomFeature;
  /** Show/hide debug markers for every window/door (debug mode only). */
  setMarkersVisible(v: boolean): void;
}

// ─── Microphone ───────────────────────────────────────────────────────────

export type MicStatus = 'idle' | 'requesting' | 'granted' | 'denied' | 'unavailable';

export interface MicLike {
  readonly status: MicStatus;
  /** Smoothed RMS amplitude of the mic (0..1). */
  readonly level: number;
  /** Measured room level (RMS), null until calibrated. Never below CONFIG.mic.baselineFloorRms. */
  readonly baseline: number | null;
  /** baseline * CONFIG.mic.noiseRatio (Infinity until calibrated). */
  readonly threshold: number;
  /** level > threshold. */
  readonly noisy: boolean;
  /** Track settings the browser actually applied (echoCancellation etc.), for the debug overlay. */
  readonly settings: MediaTrackSettings | null;
  /** Ask for permission. Must be called from a user gesture (title page). Never throws. */
  request(): Promise<MicStatus>;
  /** Start/finish measuring the room's normal level (intro). */
  beginCalibration(): void;
  /** Returns the baseline (null if the mic isn't available). */
  endCalibration(): number | null;
  update(dt: number): void;
}

// ─── Audio ────────────────────────────────────────────────────────────────

export interface SpatialVoice {
  /** Connect sources here. */
  readonly input: AudioNode;
  setPosition(p: Vector3): void;
  dispose(): void;
}

export interface LoopHandle {
  /** 0..1 — how intense/fast/loud the loop is. */
  setIntensity(x: number): void;
  /** Fade out and release. */
  stop(fadeSec?: number): void;
}

export type OneShot =
  | 'lightsOut'
  | 'dawn'
  | 'calibrated'
  | 'placed'
  | 'flashOn'
  | 'flashOff'
  | 'flashEmpty'
  | 'deskRetreat'
  | 'glassRetreat'
  | 'doorRetreat'
  | 'listenerLeave'
  | 'grab'
  | 'scream'
  | 'faceRush'
  | 'doorBurst';

export interface SoundBank {
  /** Night room tone: quiet but always present, so the Listener's silence is noticeable. */
  ambience(out: AudioNode): LoopHandle;
  /** Under the Desk warning: fingernails on wood. */
  scratching(out: AudioNode): LoopHandle;
  /** Peeker warning: tapping on glass. */
  glassTaps(out: AudioNode): LoopHandle;
  /** Knocker warning: handle rattle that turns into knocking; intensity = urgency. */
  doorKnocks(out: AudioNode): LoopHandle;
  /** Knocker: door creaking open; intensity = how open. */
  doorCreak(out: AudioNode): LoopHandle;
  /** Listener: faint high ringing (plays on the over-bus, not cut). */
  ringing(out: AudioNode): LoopHandle;
  /** Subtle heartbeat that rises with the highest danger meter. */
  heartbeat(out: AudioNode): LoopHandle;
  oneShot(name: OneShot, out: AudioNode, gain?: number): void;
}

export interface AudioEngineLike {
  readonly ctx: AudioContext;
  /** Everything the Listener silences. */
  readonly gameBus: AudioNode;
  /** Sounds that ignore the Listener cut (ringing, caught screams). */
  readonly overBus: AudioNode;
  readonly sounds: SoundBank;
  /** Spatialised (HRTF) voice at a world position routed to a bus. */
  createVoice(position: Vector3, bus?: 'game' | 'over', refDistance?: number): SpatialVoice;
  /** Listener: cut / restore all game audio. */
  setGameCut(cut: boolean): void;
  readonly gameCut: boolean;
  /** RMS of what the game bus is outputting right now (debug: does the mic hear us?). */
  gameOutputLevel(): number;
  /** Resume the context (call from a user gesture too). */
  resume(): Promise<void>;
  /** Copy the head's world pose to the Web Audio listener. Call every frame. */
  updateListener(head: Object3D): void;
}

// ─── FX ───────────────────────────────────────────────────────────────────

export interface DarknessLike {
  /** Fade toward `opacity` (0 = real room, CONFIG.darkness.nightOpacity = night) over `sec`. */
  fadeTo(opacity: number, sec: number): void;
  readonly opacity: number;
  /** Follows the head. */
  update(dt: number, headPos: Vector3): void;
}

export interface FlashlightLike {
  /** Light is on (pinching, allowed, battery left). */
  readonly on: boolean;
  /** 0..1 battery left this night. */
  readonly battery: number;
  /** Which hand holds it while on. */
  readonly hand: Side | null;
  readonly origin: Vector3;
  readonly direction: Vector3;
  /** Is a world point inside the beam right now? (false when off) */
  containsPoint(p: Vector3): boolean;
  /** Only usable during nights. */
  setAllowed(allowed: boolean): void;
  /** Full battery (between nights / on restart). */
  refill(): void;
  update(dt: number, hands: HandsState, audio: AudioEngineLike): void;
}

export interface TextCardOptions {
  /** World height of a text line, m. Default 0.06. */
  size?: number;
  /** CSS colour. */
  color?: string;
  /** Auto-hide after this many seconds. */
  durationSec?: number;
  /** 'gaze': floats ~1.2 m in front of the head and lazily follows it. 'world': fixed at `position`. */
  mode?: 'gaze' | 'world';
  position?: Vector3;
  /** Smaller second line. */
  subtitle?: string;
  /** Fade-in seconds. Default 0.6. */
  fadeInSec?: number;
}

export interface TextCardLike {
  show(text: string, opts?: TextCardOptions): void;
  hide(fadeSec?: number): void;
  readonly visible: boolean;
  update(dt: number, head: Object3D): void;
}

// ─── Threat presenters ────────────────────────────────────────────────────

/** Everything a threat (and the debug overlay) can see each frame. */
export interface FrameContext {
  dt: number;
  time: number;
  /** world.player.head (current-frame pose). */
  head: Object3D;
  readonly headPos: Vector3;
  /** Unit forward vector of the head. */
  readonly headForward: Vector3;
  hands: HandTrackerLike;
  desk: Desk | null;
  room: RoomScannerLike;
  flashlight: FlashlightLike;
  mic: MicLike;
  audio: AudioEngineLike;
}

export interface ThreatPresenter {
  readonly id: ThreatId;
  /** Two-to-four word scrawl shown near the threat during its teaching attack. */
  readonly teachingHint: string;
  /** Create (hidden) scene objects. Called once after World.create. */
  init(world: World): void;
  /** Can this threat run at all right now? (e.g. Peeker needs a window, Listener needs the mic). */
  available(ctx: FrameContext): boolean;
  /** "Is the player countering me right now?" — the only rule each threat defines. */
  isCountering(ctx: FrameContext): boolean;
  /** An attack begins: pick a location, start the warning. */
  begin(attack: AttackView, ctx: FrameContext): void;
  /** Every frame while the attack is active (meter in attack.meter). */
  update(attack: AttackView, ctx: FrameContext): void;
  /** The threat was countered long enough: retreat. */
  leave(ctx: FrameContext): void;
  /** The meter filled: play the caught moment (must fit inside CONFIG.caught.pauseSec). */
  caught(ctx: FrameContext): void;
  /** Every frame, always (drives retreat / caught animations after the attack ends). */
  tick(ctx: FrameContext): void;
  /** Where to draw the teaching hint (world). */
  hintAnchor(ctx: FrameContext, out: Vector3): Vector3;
  /** Hide every visual now but let sounds already playing finish (the caught cut to black). */
  hideVisuals(): void;
  /** Instantly hide everything and stop all sound (night restart / ending). */
  reset(): void;
}

// ─── Debug overlay ────────────────────────────────────────────────────────

export interface DebugInfo {
  phase: Phase;
  night: number;
  phaseTimeSec: number;
  runner: NightRunnerLike | null;
  /** Threats scheduled tonight / switched off (e.g. Listener when the mic is denied). */
  threatsTonight: readonly ThreatId[];
  disabled: readonly ThreatId[];
  fps: number;
  /** Current intro step, e.g. 'calibrating 62%', 'place window', 'done'. */
  introStep: string;
  /** Does the mic hear the game's own sounds? Ratios are mic level / room baseline. */
  micLeak: {
    gameLevel: number;
    /** Peak-decayed mic ratio while game audio is playing (not cut). */
    ratioWhileGameAudible: number;
    /** Same while the Listener has cut game audio. */
    ratioWhileCut: number;
  };
  /** e.g. "72Hz alpha-blend hand-tracking plane-detection ..." */
  session: string;
  /** Recent game events, newest last. */
  log: readonly string[];
}

export interface DebugOverlayLike {
  setVisible(v: boolean): void;
  readonly visible: boolean;
  /** Redraws at most CONFIG.debug.overlayHz times per second. */
  update(ctx: FrameContext, info: DebugInfo): void;
}

// ─── Title page (2D, before XR) ───────────────────────────────────────────

export interface TitleHandlers {
  /** Step 1 ("Begin"): resume audio + ask for the mic. Called inside the click. */
  onBegin(): Promise<MicStatus>;
  /** Step 2 ("Enter"): MUST call world.launchXR() synchronously inside the click. */
  onEnter(): void;
}

export interface TitleController {
  /** Show the mic result (granted, or the "Listener is turned off" notice). */
  setMicStatus(s: MicStatus): void;
  /** Whether immersive-ar is supported (false: explain it needs a Quest 3 / 3S browser). */
  setXRSupport(supported: boolean, detail?: string): void;
  /** Shown again after the player leaves XR; text says where they will resume. */
  setResume(text: string | null): void;
  show(): void;
  hide(): void;
}
