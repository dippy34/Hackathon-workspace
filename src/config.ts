/**
 * Every timing and tuning value in Hold Still lives here, and only here.
 *
 * The game-design numbers mirror docs/DESIGN.md (the source of truth). If you
 * change a value after a playtest, update DESIGN.md in the same commit.
 * Values marked "impl" are implementation tuning; the ones that change how
 * the game plays are listed in DESIGN.md's "Implementation tuning" table.
 */

export type ThreatId = 'underDesk' | 'listener' | 'peeker' | 'knocker';

export const THREAT_IDS: readonly ThreatId[] = [
  'underDesk',
  'listener',
  'peeker',
  'knocker',
];

export interface ThreatTuning {
  /** Seconds of not countering (at 1.0x aggression) until the meter is full. */
  caughtAfterSec: number;
  /** Seconds of (cumulative) countering until the threat leaves. */
  leavesAfterSec: number;
  /** Average gap between the end of one attack and the start of the next, at 1.0x. */
  avgGapSec: number;
  /** Does countering this threat occupy the player's hands? (fairness rule) */
  usesHands: boolean;
}

export interface NightTuning {
  /** 1..5 */
  night: number;
  threats: readonly ThreatId[];
  /** Attacks come sooner (gap / aggression) and the meter fills faster (x aggression). */
  aggression: number;
  lengthSec: number;
  /** Max simultaneous attacks this night (fairness rule). */
  maxConcurrent: number;
}

export const CONFIG = {
  // ─── Threats (DESIGN.md "The threats") ────────────────────────────────────
  threats: {
    underDesk: {
      caughtAfterSec: 1.5,
      leavesAfterSec: 6,
      avgGapSec: 25,
      usesHands: true,
    },
    listener: {
      caughtAfterSec: 0.3,
      leavesAfterSec: 8,
      avgGapSec: 30,
      usesHands: false,
    },
    peeker: {
      caughtAfterSec: 8,
      leavesAfterSec: 2.5,
      avgGapSec: 20,
      usesHands: true,
    },
    knocker: {
      caughtAfterSec: 5,
      leavesAfterSec: 4,
      avgGapSec: 30,
      usesHands: true,
    },
  } satisfies Record<ThreatId, ThreatTuning>,

  // ─── Nights (DESIGN.md "The nights") ──────────────────────────────────────
  nights: [
    { night: 1, threats: ['underDesk'], aggression: 1.0, lengthSec: 120, maxConcurrent: 2 },
    { night: 2, threats: ['underDesk', 'peeker'], aggression: 1.0, lengthSec: 120, maxConcurrent: 2 },
    { night: 3, threats: ['underDesk', 'peeker', 'listener'], aggression: 1.15, lengthSec: 120, maxConcurrent: 2 },
    { night: 4, threats: ['underDesk', 'peeker', 'listener', 'knocker'], aggression: 1.3, lengthSec: 120, maxConcurrent: 2 },
    { night: 5, threats: ['underDesk', 'peeker', 'listener', 'knocker'], aggression: 1.6, lengthSec: 120, maxConcurrent: 3 },
  ] satisfies NightTuning[],

  // ─── Fairness + scheduling (DESIGN.md "Fairness rules") ───────────────────
  scheduler: {
    /** Reaction time added to the fairness check. */
    reactionSec: 1.5,
    /** impl: each gap is avgGap/aggression times a random factor in [min, max]. */
    gapJitterMin: 0.5,
    gapJitterMax: 1.5,
    /** A threat's teaching attack starts within this many seconds of the night beginning. */
    teachingStartWithinSec: 10,
    /** impl: earliest the teaching attack may start (lets the darkness settle first). */
    teachingStartEarliestSec: 4,
    /** impl: the teaching attack is due this long before teachingStartWithinSec at the latest. */
    teachingStartMarginSec: 0.5,
    /** impl: no new attack (other than teaching) starts in the first N seconds of a night. */
    quietOpeningSec: 6,
    /** impl: no new attack starts in the last N seconds of a night. */
    quietClosingSec: 4,
  },

  /** impl: meter drain speed while countering, as a multiple of its fill speed at 1.0x. */
  meterDrainMultiplier: 1.0,

  /** impl: longest frame (s) the game simulates; a longer hitch slows game time instead of skipping ahead. */
  maxFrameSec: 0.1,

  // ─── Caught (DESIGN.md core rule 5) ───────────────────────────────────────
  caught: {
    /**
     * Caught -> restart: the caught moment and the black screen. Together with
     * flow.restartIntroSec this is DESIGN.md's "about a 3-second pause".
     */
    pauseSec: 1.8,
    /** impl: seconds of caught moment before the screen cuts to black (inside pauseSec). */
    cutToBlackSec: 0.9,
    /** impl: how fast the cut to black (and the "Night N / Again." card) happens. */
    blackFadeSec: 0.08,
  },

  // ─── Hands (DESIGN.md Under the Desk, Knocker, Peeker) ─────────────────────
  hands: {
    /** Palm within this distance (m) of the calibrated desk height counts as "on the desk". */
    flatHeightToleranceM: 0.05,
    /** impl: palm normal within this angle of straight down counts as "facing down". */
    flatPalmDownMaxAngleDeg: 40,
    /** impl: palm normal within this angle of the door direction counts as "palm out toward the door". */
    palmFacingMaxAngleDeg: 40,
    /** impl: Knocker palm must be at least this far above the desk height (so a flat hand never counts). */
    palmOutMinAboveDeskM: 0.08,
    /** impl: thumb-tip to index-tip distance (m) that starts a pinch. */
    pinchStartM: 0.02,
    /** impl: distance that ends a pinch (hysteresis). */
    pinchEndM: 0.04,
    /**
     * impl: palm speed = distance from the palm to its moving average (time constant
     * this many s) divided by this, so it reads the true speed of a steady movement but
     * stays near 0 for a still hand's millimetre tracking jitter, at any frame rate.
     */
    speedWindowSec: 0.25,
    /**
     * impl: an untracked hand keeps its last state, but its pinch lets go after this many
     * seconds of continuous tracking loss (so the flashlight can't stay on, draining, forever).
     */
    pinchLostGraceSec: 2.0,
  },

  // ─── Room scan (BUILD_SPEC "Room") ────────────────────────────────────────
  room: {
    /** impl: windows/doors closer than this (m) to each other are the same feature. */
    featureMergeDistM: 0.3,
    /** impl: the placement aim ray only snaps to detected walls within this distance (m). */
    placementMaxDistM: 8,
    /** impl: size (m) given to a manually placed window. */
    placedWindowWidthM: 1.0,
    placedWindowHeightM: 1.2,
    /** impl: size (m) given to a manually placed door. */
    placedDoorWidthM: 0.9,
    placedDoorHeightM: 2.0,
    /**
     * impl: a detected "window" at least this tall (m) is ignored. Quest labels Space Setup's
     * invisible walls (open-plan room boundaries) 'window', and those are full wall height.
     */
    maxWindowHeightM: 2.3,
  },

  // ─── Microphone (DESIGN.md Listener + intro) ──────────────────────────────
  mic: {
    /** "Noise" = louder than this multiple of the room's normal level (RMS amplitude). */
    noiseRatio: 4,
    /** impl: the measured room level is never taken as lower than this RMS (very quiet rooms). */
    baselineFloorRms: 0.004,
    /** impl: smoothing time constant (s) for the live level. */
    levelSmoothingSec: 0.05,
  },

  // ─── Flashlight (DESIGN.md Peeker) ────────────────────────────────────────
  flashlight: {
    /** Seconds of light per night; refills between nights. */
    batterySec: 45,
    /** impl: half-angle (deg) of the cone that counts as "in the beam". */
    beamHalfAngleDeg: 14,
    /** impl: how far (m) the beam reaches. */
    beamRangeM: 9,
    /** impl: battery fraction below which the battery glow starts to flicker. */
    lowBatteryFraction: 0.2,
    /** impl: smoothing time constant (s) of the beam's aim (kills hand-tracking jitter). */
    smoothingSec: 0.04,
    /** impl: half-angle of the visible beam, as a multiple of beamHalfAngleDeg (soft edges). */
    visualAngleScale: 1.5,
    /** impl: brightness of the visible (volumetric) beam at full battery. */
    beamGlow: 0.6,
    /** impl: how much the beam dims as the battery runs from lowBatteryFraction to empty (0..1). */
    lowBatteryDim: 0.45,
  },

  // ─── Intro / calibration (DESIGN.md "The intro") ──────────────────────────
  intro: {
    /** impl: both hands must be flat-ish and still this long to calibrate. */
    holdSec: 3,
    /** impl: the two palms must be within this height (m) of each other. */
    handsLevelToleranceM: 0.06,
    /** impl: max palm speed (m/s) that counts as "still". */
    stillMaxSpeedMps: 0.12,
    /** impl: how long (s) the room scan may take before falling back to point-and-pinch placement. */
    roomScanTimeoutSec: 4,
    /** impl: pause after "Good." before the next intro prompt. */
    calibratedBeatSec: 1.4,
    /** impl: calibration forgives a hand dropping out of tracking for this long. */
    holdGraceSec: 0.35,
    /** impl: a placement pinch counts only after the prompt has been up this long. */
    placementSettleSec: 0.6,
    /** impl: calibrating palms must be at least this far below the head (m). */
    minPalmBelowHeadM: 0.2,
    /** impl: placement ray length (m) when it hits no detected wall. */
    placementFallbackDistM: 2.5,
  },

  // ─── Look (BUILD_SPEC "open for creativity") ──────────────────────────────
  darkness: {
    /** impl: seconds for the room to go dark at night start ("like the lights going out"). */
    fadeInSec: 6,
    /** impl: seconds to fade back to the real room at the ending / between nights. */
    fadeOutSec: 3,
    /** impl: darkness opacity at full night ("nearly black"). */
    nightOpacity: 0.94,
    /** impl: radius (m) of the darkness shell around the player's head. */
    radiusM: 12,
    /** impl: once fully dark, opacity slowly "breathes" by this fraction (±). */
    breathAmplitude: 0.015,
    /** impl: the dying-bulb flicker plays in this first fraction of a lights-out fade. */
    flickerFraction: 0.15,
    /** impl: film grain strength (opacity units, peak to peak). */
    grain: 0.025,
  },

  /** impl: floating text (TextCard) and teaching-hint scrawls (ScrawlLabel). */
  text: {
    /** impl: default world height (m) of one line of card text. */
    lineHeightM: 0.06,
    /** impl: default card fade-in / fade-out (s). */
    fadeInSec: 0.6,
    fadeOutSec: 0.8,
    /** impl: word-wrap width in characters. */
    charsPerLine: 28,
    /** impl: 'gaze' cards float this far (m) in front of the head. */
    gazeDistanceM: 1.2,
    /** impl: a 'gaze' card glides back to centre once it is this far (deg) off. */
    gazeRecentreDeg: 25,
    /** impl: a 'gaze' card may sink this far (deg) below eye level when the player looks down (e.g. at the desk). */
    gazeMaxDownDeg: 25,
    /** impl: peak opacity of a hint scrawl (faint on purpose). */
    scrawlOpacity: 0.55,
    /** impl: a scrawl keeps this angular height (deg) at any distance. */
    scrawlLineDeg: 2.6,
    /** impl: seconds for a scrawl to be "written" in, and to fade in / out. */
    scrawlWriteSec: 0.9,
    scrawlFadeSec: 0.5,
  },

  flow: {
    /** impl: "Night N" card + darkness fade before the night clock starts. */
    nightIntroSec: 6,
    /** impl: lead-in when a night restarts after being caught (pauseSec + this = about 3 s). */
    restartIntroSec: 1.2,
    /** impl: pause after surviving a night before the next one starts. */
    nightClearedSec: 6,
    /** impl: how long a teaching hint stays scrawled near a threat's first attack. */
    teachingHintSec: 5,
    /** impl: the room fades back to normal when the intro starts. */
    introFadeSec: 0.5,
    /** impl: "Night N" / "survived" cards hide this long before their phase ends. */
    cardEarlyHideSec: 0.6,
  },

  audio: {
    /** impl: master volume of all game audio. */
    masterGain: 0.9,
    /** impl: how fast (s) game audio cuts out when the Listener arrives. */
    listenerCutSec: 0.12,
    /** impl: volume of the Listener's faint ringing (kept low so the mic barely hears it). */
    ringingGain: 0.025,
    /** impl: seconds for the Listener's ringing to swell in. */
    ringingSwellSec: 2.5,
    /** impl: limiter threshold (dBFS) on the master output so jumpscares never clip. */
    limiterThresholdDb: -3,
    /** impl: time constant (s) with which the Web Audio listener / voices follow their poses. */
    poseSmoothingSec: 0.012,
    /** impl: distance roll-off of spatial voices (inverse distance model). */
    voiceRolloff: 1.2,
    /** impl: default reference distance (m) of spatial voices (full volume inside it). */
    voiceRefDistanceM: 0.6,
    /** impl: how far ahead (s) the sound scheduler books events, and its timer period (ms). */
    schedulerLookaheadSec: 0.12,
    schedulerIntervalMs: 25,
    /** impl: CPU guard: above this many live transient sounds, loops skip optional events. */
    maxLiveEvents: 48,
    /** impl: heartbeat rate (bpm) at intensity 0 and 1 (intensity = highest danger meter). */
    heartbeatBpmMin: 55,
    heartbeatBpmMax: 120,
    /** impl: random gap (s) between distant house creaks/ticks in the night ambience. */
    ambienceEventMinSec: 6,
    ambienceEventMaxSec: 15,
    /** impl: loudness of each procedural loop before spatialisation (balance the mix here). */
    loopLevels: {
      ambience: 0.6,
      scratching: 1.0,
      glassTaps: 1.0,
      doorKnocks: 1.0,
      doorCreak: 0.8,
      heartbeat: 0.45,
    },
    /** impl: loudness of each one-shot (multiplied by the caller's gain). */
    oneShotLevels: {
      lightsOut: 0.8,
      dawn: 0.6,
      calibrated: 0.6,
      placed: 0.6,
      flashOn: 0.5,
      flashOff: 0.45,
      flashEmpty: 0.5,
      deskRetreat: 0.8,
      glassRetreat: 0.9,
      doorRetreat: 0.9,
      listenerLeave: 0.6,
      grab: 1.0,
      scream: 1.0,
      faceRush: 1.0,
      doorBurst: 1.0,
    },
  },

  // ─── Threat presentation (BUILD_SPEC "open": looks, sound, caught moments) ─
  threatFx: {
    /** impl: seconds a threat's spatial voice lingers after it leaves, so its retreat sound can finish. */
    voiceLingerSec: 3,
    /** impl: while countered, a threat's own warning loop (scratching, taps, knocks/creak) drops to this gain. */
    counterDuck: 0.15,
    /** impl: time constant (s) of that duck, both ways (about 3x this to settle). */
    counterDuckSec: 0.08,
    underDesk: {
      /** impl: the scratching comes from this far below the desk centre (m)... */
      voiceBelowDeskM: 0.45,
      /** impl: ...and this far from the desk centre toward the player (m). */
      voiceTowardPlayerM: 0.15,
      /** impl: the desk's near edge, measured from the calibrated palm midpoint toward the player (m). */
      nearEdgeM: 0.3,
      /** impl: calibrated palm height above the real desk surface (m). */
      palmAboveSurfaceM: 0.025,
      /** impl: seconds for the fingers to withdraw under the desk when it leaves. */
      withdrawSec: 0.9,
      /** impl: seconds for the caught hand to lunge from under the desk to the face. */
      lungeSec: 0.35,
      /**
       * impl: the caught hand's knuckles stop this far in front of the eyes (m; comfort). The smother
       * pose arcs the fingers up and out past the view instead of folding them back at the eyes, so
       * with lungeScale every visible part of the hand stays >= 5 cm (target >= 8 cm) from both eyes
       * at any gaze yaw/pitch (camera near 0.02 m).
       */
      lungeFaceDistM: 0.16,
      /**
       * impl: the caught hand comes up from this far below eye level (m, along the gaze's own up, so a
       * pitched gaze keeps the same framing), so its hooked fingertips and nails close right in front
       * of the eyes instead of above the view.
       */
      lungeDropM: 0.11,
      /** impl: the lunge arcs up by this much at its midpoint (m, along the gaze's own up). */
      lungeArcM: 0.06,
      /** impl: if the hand never came up, it lunges from this far below the desk edge (m)... */
      lungeHiddenBelowM: 0.22,
      /** impl: ...and this far in front of the edge, toward the player (m). */
      lungeHiddenTowardM: 0.03,
      /**
       * impl: the lunge only starts where the hand is when it is ahead of the gaze: the cosine of its
       * angle off the gaze, in 3D and in plan view, must be at least this. Otherwise (the player looking
       * away from, or high over, the desk) a straight lunge would sweep through the head, so it starts
       * lungeRestartAheadM ahead of and lungeRestartBelowM below the eyes instead (in the gaze's own
       * frame: just out of view below it, about where a desk-facing lunge starts).
       */
      lungeAheadMinCos: 0.35,
      /** impl: restart distance ahead of the eyes along the gaze (m), see lungeAheadMinCos... */
      lungeRestartAheadM: 0.4,
      /** impl: ...and below the eyes along the gaze's up (m). */
      lungeRestartBelowM: 0.5,
      /** impl: through the lunge the desk shadow sinks this far under the desk (m), so the whole lunge stays visible. */
      lungeShadeSinkM: 1.0,
      /**
       * impl: the claw closes over the face from clawCloseFromLunges to clawClosedAtLunges lunge
       * durations (lungeSec) into the caught moment. If that would end later than clawClosedByCutFrac of
       * caught.cutToBlackSec, the whole close is scaled earlier (same proportions), so the claw is
       * always closed before the cut to black whatever lungeSec is.
       */
      clawCloseFromLunges: 1.1,
      clawClosedAtLunges: 2.2,
      clawClosedByCutFrac: 0.9,
      /** impl: caught hand brightness while it fills the view, dimming to caughtCoveredBrightness as the claw closes... */
      caughtBrightness: 1.0,
      caughtCoveredBrightness: 0.3,
      /** impl: ...with this much brightness flicker (+-). */
      caughtFlicker: 0.08,
      /** impl: the caught hand grows by this factor on its way to the face (the palm fills most of the view). */
      lungeScale: 1.4,
      /** impl: hand colour scale in the dark (only top-facing knuckles, nails and the rim catch light)... */
      darkBrightness: 0.13,
      /** impl: ...and in the flashlight beam (its shading also turns frontal: the beam is the reveal). */
      litBrightness: 1.1,
      /** impl: the 'desk shadow': below the desk surface the hand fades to black over this depth (m)... */
      shadeDepthM: 0.1,
      /** impl: ...and is at full value this far above the surface (m). */
      shadeLiftM: 0.005,
      /** impl: the beam pushes that shadow this much deeper under the desk (m). */
      shadeLitDropM: 0.08,
      /**
       * impl: the hand's darkest tone (sRGB hex): what the forearm fade, the desk shadow and the fade
       * in/out sink into. About the darkness shell's own colour, so only a faint silhouette remains.
       */
      shadowColor: 0x0a0d12,
      /** impl: seconds for the eyes under the desk to fade in when it arrives. */
      eyeFadeInSec: 1.2,
      /** impl: gain of the caught 'grab' one-shot. */
      grabGain: 1.2,
    },
    peeker: {
      /** impl: the face first appears this far outside the window plane (m). */
      startOutsideM: 0.25,
      /** impl: at a full meter the face has come this far through the glass into the room (m). */
      fullInsideM: 0.6,
      /** impl: how far the face recoils while it is lit (m). */
      flinchRecoilM: 0.08,
      /** impl: smoothing rate (1/s) of the meter the face follows through the glass. */
      meterRate: 2.5,
      /** impl: rates (1/s) at which the face lights up in the beam, flinches and recoils (both ways). */
      litRate: 12,
      flinchRate: 9,
      recoilRate: 5,
      /** impl: expression rates (1/s): the eyes snap shut, the mouth opens slowly, the caught scream is all but instant. */
      squintRate: 10,
      screamRate: 2.5,
      rushExprRate: 16,
      /** impl: the glass haze (glassHaze) clears as the face's depth goes from this (m, negative is outside)... */
      hazeFromDepthM: -0.2,
      /** impl: ...to this (m, just inside the glass). */
      hazeToDepthM: 0.02,
      /** impl: brightness factor at a zero meter, rising by meterBrightnessGain at a full meter... */
      meterBrightnessBase: 0.9,
      meterBrightnessGain: 0.2,
      /** impl: ...and the teaching pass is this factor brighter still (findable at the window). */
      teachingBoost: 1.15,
      /** impl: breath-on-glass smear opacity while the face crosses the glass, and what lingers once it is through. */
      smearCrossing: 0.13,
      smearInside: 0.03,
      /** impl: face brightness in the dark (faint self-glow) and when caught in the beam. */
      darkBrightness: 0.3,
      litBrightness: 1.0,
      /** impl: dark brightness at a zero meter (it surfaces to darkBrightness as it comes in; the teaching pass stays at darkBrightness). */
      darkBrightnessFar: 0.18,
      /** impl: opacity factor while the face is behind the glass (hazy, more ghost than object); 1 once inside. */
      glassHaze: 0.35,
      /** impl: head tilt amplitude (rad) at a low meter, leaning to headLeanRad (inhuman) at a full meter. */
      headTiltRad: 0.06,
      headLeanRad: 0.32,
      /** impl: the tilt starts becoming that lean at this smoothed meter. */
      leanFromMeter: 0.4,
      /** impl: a rare (~every 2-3 s), ~60 ms micro-twitch of the head (rad)... */
      twitchRad: 0.07,
      /** impl: ...fired as value noise at twitchHz (changes/s) rises through twitchGateFrom..twitchGateTo (of 1). */
      twitchGateFrom: 0.9,
      twitchGateTo: 0.96,
      twitchHz: 9,
      /** impl: seconds for the face to pull back outside and fade when it leaves. */
      retreatSec: 1.1,
      /** impl: seconds for the face to fade in outside the window when it arrives. */
      fadeInSec: 1.4,
      /** impl: seconds for the face to rush at the player's head when caught. */
      rushSec: 0.4,
      /** impl: the rushing face's surface stops this far in front of the eyes (m; comfort). */
      rushFaceDistM: 0.17,
      /**
       * impl: the rush only starts where the face is when it is ahead of the gaze: the cosine of its
       * angle off the gaze, in 3D and in plan view, must be at least this. Otherwise (a window behind or
       * beside the player, or a steep gaze) a straight rush would sweep through the head, so it starts
       * rushRestartAheadM ahead instead.
       */
      rushAheadMinCos: 0.5,
      /** impl: restart distance ahead of the head along the horizontal gaze, at eye height (m), see rushAheadMinCos. */
      rushRestartAheadM: 1.2,
      /** impl: the rushing face grows by this factor on its way in. */
      rushGrow: 1.2,
      /** impl: on arrival the face punches this far past the stop (m, peak) and springs back... */
      rushPunchM: 0.015,
      /** impl: ...a damped spring of this angular rate (rad/s) and decay rate (1/s). */
      rushPunchRadPerSec: 22,
      rushPunchDecay: 6,
      /** impl: through the rest of the caught moment it creeps this much closer (m)... */
      rushCreepM: 0.025,
      /**
       * impl: ...its jaw keeps dropping past full to this scream-morph overdrive (1 = full; clamped to
       * the face model's SCREAM_MAX, 1.25, in scene-assets/peeker-face.scene-asset.ts)...
       */
      rushScreamMax: 1.2,
      /** impl: ...and its head snaps to a cant (rad) rushCantAtSec after arrival (about 0.5 s in), over rushCantSnapSec. */
      rushCantRad: 0.3,
      rushCantAtSec: 0.12,
      rushCantSnapSec: 0.06,
      /** impl: caught face brightness (keeps the baked form; never over-exposed) and the strobe it drops to for a frame or two. */
      rushBrightness: 0.8,
      rushStrobeLow: 0.15,
      /** impl: the strobe drops it to rushStrobeLow while a value noise (-1..1) is above this. */
      rushStrobeAbove: 0.7,
      /** impl: gain of the caught 'faceRush' one-shot. */
      faceRushGain: 1.2,
      /** impl: scale of the sculpted face (built at real size, ~0.18 m wide): a little too large for a person. */
      faceScale: 1.1,
      /** impl: how far the head turns away from the beam when it flinches (rad); the chin dips by half that. */
      flinchTurnRad: 0.2,
      /** impl: the jaw starts to hang slack at this (smoothed) meter... */
      screamFromMeter: 0.35,
      /** impl: ...and is this open (0..1) at a full meter. It opens fully (and past full) when caught. */
      screamAtFullMeter: 0.45,
    },
    knocker: {
      /** impl: height above the floor (m) of the door's sound (handle height). */
      voiceHeightM: 1.0,
      /** impl: width (m) of the light sliver at the door's edge at an empty / full meter. */
      sliverMinM: 0.006,
      sliverMaxM: 0.16,
      /** impl: fraction the sliver narrows while a palm holds the door back. */
      pushBackNarrow: 0.35,
      /** impl: seconds for the light to close when it leaves. */
      closeSec: 0.7,
      /** impl: seconds for the light sliver to fade in when it arrives. */
      fadeInSec: 0.8,
      /** impl: seconds for the door to fling fully open when caught. */
      burstOpenSec: 0.12,
      /** impl: seconds for the silhouette to rush from the burst door to the player when caught. */
      rushSec: 0.55,
      /** impl: the rushing figure stops this far in front of the eyes (m; comfort). */
      rushFaceDistM: 0.25,
      /** impl: gain of the caught 'doorBurst' one-shot. */
      doorBurstGain: 1.2,
    },
    listener: {
      /** impl: the caught scream plays this far beside the head (m). */
      screamOffsetM: 0.12,
      /** impl: gain of the caught 'scream' one-shot ("right next to the ear"). */
      screamGain: 1.6,
      /** impl: seconds the caught scream keeps following the ear before its voice is released. */
      screamFollowSec: 3,
      /**
       * impl: after the game audio has cut out (audio.listenerCutSec), the mic is still ignored this
       * long, so the game's own fading sound (speaker leak, output latency, mic smoothing) never
       * counts as the player making noise.
       */
      onsetGraceSec: 0.25,
      /** impl: ringing intensity at an empty / full meter (it rises only very slightly). */
      ringingMin: 0.35,
      ringingMax: 0.55,
    },
  },

  title: {
    /** impl: if the mic prompt still hasn't answered after this long, "Enter the room" unlocks anyway. */
    micGraceSec: 10,
  },

  debug: {
    /** Overlay shown by default during development (M1). Override with ?debug=0 / ?debug=1. */
    overlayDefault: true,
    /** impl: overlay redraws per second. */
    overlayHz: 6,
    /** impl: overlay panel width (m; it is square). */
    overlayWidthM: 0.46,
    /** impl: opacity of the panel's dark background (0..1). */
    overlayBgOpacity: 0.72,
    /** impl: with a desk the panel stands off to the player's left, clear of the hands and the view ahead: centre this far left of the desk centre (m)... */
    overlayDeskLeftM: 0.5,
    /** impl: ...this far beyond it, away from the player (m)... */
    overlayBeyondDeskM: 0.05,
    /** impl: ...and this far above the desk height (m); it tilts back to face the head. */
    overlayAboveDeskM: 0.24,
    /** impl: without a desk: panel this far from the head (m), off to the left and down of where the player looks (deg). */
    overlayHeadDistM: 0.85,
    overlayHeadLeftDeg: 38,
    overlayHeadDownDeg: 12,
    /**
     * impl: the overlay says "mic hears game: YES" when the average mic/room ratio
     * while game audio plays is at least this multiple of the ratio while it's cut.
     */
    micLeakRatio: 1.5,
    /** impl: averaging time (s) for that check. */
    micLeakAverageSec: 4,
    /** impl: game output level (RMS) above which game audio counts as "playing" for that check. */
    micLeakGameLevel: 0.005,
  },
} as const;

export function nightTuning(night: number): NightTuning {
  const n = CONFIG.nights.find((x) => x.night === night);
  if (!n) throw new Error(`No night ${night}`);
  return n;
}

/** The first night each threat appears in (its "teaching" night). */
export function introducedOnNight(id: ThreatId): number {
  for (const n of CONFIG.nights) if ((n.threats as readonly ThreatId[]).includes(id)) return n.night;
  return Infinity;
}

export const NIGHT_COUNT = CONFIG.nights.length;
