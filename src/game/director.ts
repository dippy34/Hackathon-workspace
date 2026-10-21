import { createSystem, Quaternion, Vector3, VisibilityState, type World } from '@iwsdk/core';
import { CONFIG, NIGHT_COUNT, THREAT_IDS, nightTuning, type ThreatId } from '../config.js';
import { GameFlow } from '../core/game-flow.js';
import type { AttackView, Phase } from '../core/types.js';
import { AudioEngine } from '../audio/engine.js';
import { DebugOverlay } from '../debug/overlay.js';
import { Darkness } from '../fx/darkness.js';
import { Flashlight } from '../fx/flashlight.js';
import { styleHands } from '../fx/hand-look.js';
import { ScrawlLabel, TextCard } from '../fx/text-card.js';
import { HandTracker } from '../senses/hands.js';
import { Mic } from '../senses/mic.js';
import { RoomScanner } from '../senses/room.js';
import { KnockerThreat } from '../threats/knocker.js';
import { ListenerThreat } from '../threats/listener.js';
import { PeekerThreat } from '../threats/peeker.js';
import { UnderDeskThreat } from '../threats/under-desk.js';
import type { DebugInfo, Desk, FrameContext, LoopHandle, ThreatPresenter } from './contracts.js';
import { Intro } from './intro.js';

const LOG_LINES = 6;

/**
 * The game director: owns every module, runs the GameFlow state machine, and
 * turns its events into darkness, text, sound and threat presentation.
 * Driven once per frame by DirectorSystem.
 */
export class Director {
  readonly flow: GameFlow;
  readonly hands: HandTracker;
  readonly room: RoomScanner;
  readonly darkness: Darkness;
  readonly flashlight: Flashlight;
  readonly text: TextCard;
  readonly hint: ScrawlLabel;
  readonly overlay: DebugOverlay;
  readonly intro: Intro;
  readonly threats: Record<ThreatId, ThreatPresenter>;
  readonly ctx: FrameContext;

  private desk: Desk | null = null;
  private ambience: LoopHandle | null = null;
  private heartbeat: LoopHandle | null = null;
  private disabled: ThreatId[] = [];
  private readonly log: string[] = [];
  private fps = 72;
  private sessionInfo = '';
  private paused = false;
  private cutToBlackDone = false;
  /** Night to resume once a late room-level calibration finishes (mic granted after the intro). */
  private pendingResume: number | null = null;
  private readonly headPos = new Vector3();
  private readonly headForward = new Vector3();
  private readonly headQuat = new Quaternion();
  private readonly hintPos = new Vector3();
  private readonly micLeak = { gameLevel: 0, ratioWhileGameAudible: 0, ratioWhileCut: 0 };
  private readonly debugInfo: DebugInfo;
  private readonly countering = (id: ThreatId): boolean => this.threats[id].isCountering(this.ctx);

  constructor(
    readonly world: World,
    readonly audio: AudioEngine,
    readonly mic: Mic,
    debug: boolean,
  ) {
    this.hands = new HandTracker(world);
    this.room = new RoomScanner(world);
    this.darkness = new Darkness(world);
    this.flashlight = new Flashlight(world);
    this.text = new TextCard(world);
    this.hint = new ScrawlLabel(world);
    this.overlay = new DebugOverlay(world);
    this.overlay.setVisible(debug);
    this.room.setMarkersVisible(debug);
    styleHands(world);

    this.threats = {
      underDesk: new UnderDeskThreat(),
      listener: new ListenerThreat(),
      peeker: new PeekerThreat(),
      knocker: new KnockerThreat(),
    };
    for (const id of THREAT_IDS) this.threats[id].init(world);

    const director = this;
    this.ctx = {
      dt: 0,
      time: 0,
      head: world.player.head,
      headPos: this.headPos,
      headForward: this.headForward,
      hands: this.hands,
      get desk() {
        return director.desk;
      },
      room: this.room,
      flashlight: this.flashlight,
      mic,
      audio,
    };

    this.intro = new Intro(
      world,
      this.text,
      (desk) => {
        this.desk = desk;
        this.hands.setDesk(desk);
        this.note(`desk calibrated at ${desk.height.toFixed(2)} m`);
      },
      () => this.onIntroDone(),
    );

    this.flow = new GameFlow({
      onPhaseChange: (phase, night, prev) => this.onPhase(phase, night, prev),
      onAttackStart: (a) => this.onAttackStart(a),
      onAttackLeave: (a) => {
        this.threats[a.id].leave(this.ctx);
        this.note(`${a.id} left`);
      },
      onCaught: (a) => this.onCaught(a),
      onSurvived: () => this.note(`night ${this.flow.night} survived`),
    });

    this.debugInfo = {
      phase: 'title',
      night: 0,
      phaseTimeSec: 0,
      runner: null,
      threatsTonight: [],
      disabled: this.disabled,
      fps: 0,
      introStep: '',
      micLeak: this.micLeak,
      session: '',
      log: this.log,
    };

    const xr = world.renderer.xr;
    xr.addEventListener('sessionstart', () => this.onSessionStart());
    xr.addEventListener('sessionend', () => this.onSessionEnd());
  }

  /** Called by the title page / session end handler to know where we are. */
  get resumeText(): string | null {
    if (this.flow.phase === 'ending') return 'You held still. Enter to play again.';
    const n = this.resumeNight();
    return n > 0 ? `Resume: Night ${n}` : null;
  }

  /** The night a re-entry continues from (a survived night moves on to the next one). */
  private resumeNight(): number {
    const n = this.flow.night;
    return this.flow.phase === 'nightCleared' ? Math.min(n + 1, NIGHT_COUNT) : n;
  }

  /** Session-end hook for the title page. */
  onSessionEnded: () => void = () => {};

  // ─── Frame loop ─────────────────────────────────────────────────────────

  frame(frame: XRFrame | null, refSpace: XRReferenceSpace | null, dt: number, time: number): void {
    if (!frame || !refSpace) return;
    dt = Math.min(dt, CONFIG.maxFrameSec);
    this.fps += (1 / Math.max(dt, 1e-3) - this.fps) * 0.05;

    const ctx = this.ctx;
    ctx.dt = dt;
    ctx.time = time;
    const head = this.world.player.head;
    head.getWorldPosition(this.headPos);
    head.getWorldQuaternion(this.headQuat);
    this.headForward.set(0, 0, -1).applyQuaternion(this.headQuat);

    // Senses and output always run (so tracking state survives a pause).
    this.hands.update(frame, refSpace, dt);
    this.room.update(frame, refSpace, dt);
    this.mic.update(dt);
    this.audio.updateListener(head);

    const blurred = this.world.visibilityState.peek() !== VisibilityState.Visible;
    if (blurred !== this.paused) {
      this.paused = blurred;
      this.note(blurred ? 'paused (headset menu)' : 'resumed');
    }

    if (!this.paused) {
      if (this.flow.phase === 'intro' || this.pendingResume !== null) this.intro.update(ctx);
      // While re-calibrating before a resume, the flow waits.
      if (this.pendingResume === null) this.flow.update(dt, this.countering);
      this.updateCutToBlack();
      const runner = this.flow.runner;
      if (this.flow.phase === 'night' && runner) {
        let maxMeter = 0;
        for (const a of runner.activeAttacks()) {
          this.threats[a.id].update(a, ctx);
          if (a.meter > maxMeter) maxMeter = a.meter;
        }
        this.heartbeat?.setIntensity(maxMeter);
      }
      this.flashlight.update(dt, this.hands, this.audio);
    }

    for (const id of THREAT_IDS) this.threats[id].tick(ctx);
    this.darkness.update(dt, this.headPos);
    this.text.update(dt, head);
    this.hint.update(dt, head);
    this.updateMicLeak();
    if (this.overlay.visible) this.overlay.update(ctx, this.fillDebugInfo());
  }

  // ─── Session lifecycle ─────────────────────────────────────────────────

  private onSessionStart(): void {
    const s = this.world.renderer.xr.getSession();
    if (s) {
      const rates = s.supportedFrameRates ? Array.from(s.supportedFrameRates) : [];
      if (rates.includes(72) && s.updateTargetFrameRate) s.updateTargetFrameRate(72).catch(() => {});
      this.sessionInfo = [
        s.environmentBlendMode ?? '?',
        `${s.frameRate ?? '?'}Hz`,
        ...(s.enabledFeatures ?? []),
      ].join(' ');
      console.log('[session]', this.sessionInfo, 'supported rates', rates);
    }
    void this.audio.resume();
    this.note('session start');

    const phase = this.flow.phase;
    if (phase === 'title') {
      this.flow.begin();
      return;
    }
    if (phase === 'intro') {
      this.intro.start(this.ctx);
      return;
    }
    // Play again from night 1 after the ending; otherwise replay the current night
    // from its start (or move on to the next one after surviving).
    const night = phase === 'ending' ? 1 : Math.max(1, this.resumeNight());
    if (this.mic.status === 'granted' && this.mic.baseline === null) {
      // The mic was allowed after the intro: measure the room level first, or the Listener stays off.
      this.pendingResume = night;
      this.intro.start(this.ctx);
      this.note('re-calibrating (mic allowed after the intro)');
    } else {
      this.flow.debugJumpToNight(night);
    }
  }

  private onIntroDone(): void {
    if (this.pendingResume !== null) {
      const night = this.pendingResume;
      this.pendingResume = null;
      this.flow.debugJumpToNight(night);
    } else {
      this.flow.completeIntro();
    }
  }

  private onSessionEnd(): void {
    this.resetPresentation();
    if (this.pendingResume !== null) this.intro.abort();
    // Our AudioEngine keeps running on the 2D title page: silence the night (nightIntro recreates both on resume).
    this.ambience?.stop(0.3);
    this.ambience = null;
    this.heartbeat?.stop(0.3);
    this.heartbeat = null;
    this.flashlight.setAllowed(false);
    this.darkness.fadeTo(0, 0.01);
    this.text.hide(0);
    this.note('session end');
    this.onSessionEnded();
  }

  // ─── Flow events ───────────────────────────────────────────────────────

  private onPhase(phase: Phase, night: number, prev: Phase): void {
    this.note(`${prev} → ${phase}${night ? ` (night ${night})` : ''}`);
    switch (phase) {
      case 'intro':
        this.darkness.fadeTo(0, CONFIG.flow.introFadeSec);
        this.intro.start(this.ctx);
        break;

      case 'nightIntro': {
        // A real catch-restart (a resume after leaving XR mid-catch starts the night fresh).
        const restart = prev === 'caught' && this.flow.restarts > 0;
        this.cutToBlackDone = false;
        this.resetPresentation();
        this.flashlight.refill();
        this.flashlight.setAllowed(false);
        this.updateDisabled(night);
        this.darkness.fadeTo(CONFIG.darkness.nightOpacity, restart ? CONFIG.flow.restartIntroSec : CONFIG.darkness.fadeInSec);
        if (!restart) this.audio.sounds.oneShot('lightsOut', this.audio.gameBus);
        // (After a catch, "Night N / Again." is already showing from the cut to black.)
        if (!restart) {
          this.text.show(`Night ${night}`, { mode: 'gaze', size: 0.09, durationSec: CONFIG.flow.nightIntroSec - CONFIG.flow.cardEarlyHideSec });
        }
        this.ambience ??= this.audio.sounds.ambience(this.audio.gameBus);
        this.heartbeat ??= this.audio.sounds.heartbeat(this.audio.gameBus);
        this.heartbeat.setIntensity(0);
        break;
      }

      case 'night':
        this.flashlight.setAllowed(true);
        break;

      case 'caught':
        this.flashlight.setAllowed(false);
        this.heartbeat?.setIntensity(0);
        break;

      case 'nightCleared':
        this.resetPresentation();
        this.flashlight.setAllowed(false);
        this.darkness.fadeTo(0, CONFIG.darkness.fadeOutSec);
        this.audio.sounds.oneShot('dawn', this.audio.gameBus);
        this.text.show(`Night ${night} survived.`, {
          mode: 'gaze',
          durationSec: CONFIG.flow.nightClearedSec - CONFIG.flow.cardEarlyHideSec,
        });
        break;

      case 'ending':
        this.resetPresentation();
        this.flashlight.setAllowed(false);
        this.ambience?.stop(CONFIG.darkness.fadeOutSec);
        this.ambience = null;
        this.heartbeat?.stop(CONFIG.darkness.fadeOutSec);
        this.heartbeat = null;
        this.darkness.fadeTo(0, CONFIG.darkness.fadeOutSec);
        this.audio.sounds.oneShot('dawn', this.audio.gameBus);
        this.text.show('You held still.', { mode: 'gaze', size: 0.08 });
        break;

      case 'title':
        break;
    }
  }

  private onAttackStart(a: AttackView): void {
    const presenter = this.threats[a.id];
    presenter.begin(a, this.ctx);
    if (a.teaching && CONFIG.flow.teachingHintSec > 0) {
      this.hint.show(presenter.teachingHint, presenter.hintAnchor(this.ctx, this.hintPos), CONFIG.flow.teachingHintSec);
    }
    this.note(`${a.id} attacks${a.teaching ? ' (teaching)' : ''}`);
  }

  private onCaught(a: AttackView): void {
    this.note(`caught by ${a.id}`);
    for (const id of THREAT_IDS) if (id !== a.id) this.threats[id].reset();
    this.hint.hide();
    this.flashlight.setAllowed(false);
    this.threats[a.id].caught(this.ctx);
    // The caught moment plays; frame() cuts to black at caught.cutToBlackSec.
    this.cutToBlackDone = false;
  }

  /** Caught moment over: cut to black (on the game clock, so a headset-menu pause holds it). */
  private updateCutToBlack(): void {
    if (this.flow.phase !== 'caught' || this.cutToBlackDone) return;
    if (this.flow.phaseTimeSec < CONFIG.caught.cutToBlackSec) return;
    this.cutToBlackDone = true;
    this.darkness.fadeTo(1, CONFIG.caught.blackFadeSec);
    // Hide the monster but let its caught sound finish; nightIntro's reset stops the rest.
    for (const id of THREAT_IDS) this.threats[id].hideVisuals();
    const untilClock = CONFIG.caught.pauseSec - CONFIG.caught.cutToBlackSec + CONFIG.flow.restartIntroSec;
    this.text.show(`Night ${this.flow.night}`, {
      mode: 'gaze',
      size: 0.09,
      subtitle: 'Again.',
      fadeInSec: CONFIG.caught.blackFadeSec,
      durationSec: untilClock - CONFIG.caught.blackFadeSec,
    });
  }

  // ─── Helpers ───────────────────────────────────────────────────────────

  /** Threats that can't run (DESIGN.md: no mic -> no Listener). Applied per night. */
  private updateDisabled(night: number): void {
    this.disabled.length = 0;
    for (const id of nightTuning(night).threats) {
      if (!this.threats[id].available(this.ctx)) this.disabled.push(id);
    }
    this.flow.setDisabledThreats(this.disabled);
  }

  private resetPresentation(): void {
    for (const id of THREAT_IDS) this.threats[id].reset();
    this.audio.setGameCut(false);
    this.heartbeat?.setIntensity(0);
    this.hint.hide();
  }

  /**
   * Does the mic hear the game? Slow averages of mic level / room level while
   * game audio plays vs while the Listener has cut it. Averages (not peaks) so
   * a single desk slap or cough doesn't read as leakage.
   */
  private updateMicLeak(): void {
    const leak = this.micLeak;
    leak.gameLevel = this.audio.gameOutputLevel();
    const base = this.mic.baseline;
    if (!base || this.mic.status !== 'granted') return;
    const ratio = this.mic.level / base;
    const k = 1 - Math.exp(-this.ctx.dt / CONFIG.debug.micLeakAverageSec);
    if (this.audio.gameCut) {
      leak.ratioWhileCut += (ratio - leak.ratioWhileCut) * k;
    } else if (leak.gameLevel > CONFIG.debug.micLeakGameLevel) {
      leak.ratioWhileGameAudible += (ratio - leak.ratioWhileGameAudible) * k;
    }
  }

  private fillDebugInfo(): DebugInfo {
    const d = this.debugInfo;
    d.phase = this.flow.phase;
    d.night = this.flow.night;
    d.phaseTimeSec = this.flow.phaseTimeSec;
    d.runner = this.flow.runner;
    d.threatsTonight = this.flow.night > 0 ? nightTuning(this.flow.night).threats : [];
    d.fps = this.fps;
    d.introStep = this.flow.phase === 'intro' ? this.intro.status : this.desk ? 'done' : '-';
    d.session = this.sessionInfo;
    return d;
  }

  note(msg: string): void {
    const t = this.ctx?.time ?? 0;
    this.log.push(`${t.toFixed(1)} ${msg}`);
    if (this.log.length > LOG_LINES) this.log.shift();
    console.log('[hold-still]', msg);
  }
}

/** Shared handle so the system (constructed by the ECS) can reach the director. */
export const directorRef: { current: Director | null } = { current: null };

/** Runs the director every frame, after IWSDK's input system has sampled the hands. */
export class DirectorSystem extends createSystem() {
  private errors = 0;

  update(delta: number, time: number): void {
    try {
      directorRef.current?.frame(this.xrFrame ?? null, this.world.xrReferenceSpace ?? null, delta, time);
    } catch (e) {
      // One bad frame must not stop the XR animation loop for the rest of the session.
      if (this.errors++ < 20) console.error('[hold-still] frame error', e);
    }
  }
}
