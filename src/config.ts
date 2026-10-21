/**
 * Every timing and tuning value in Hold Still lives here, and only here.
 *
 * The game-design numbers mirror docs/DESIGN.md (the source of truth). If you
 * change a value after a playtest, update DESIGN.md in the same commit.
 * Values marked "impl" are implementation tuning that DESIGN.md lists in its
 * "Implementation tuning" table.
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
    /** impl: no new attack (other than teaching) starts in the first N seconds of a night. */
    quietOpeningSec: 6,
    /** impl: no new attack starts in the last N seconds of a night. */
    quietClosingSec: 4,
  },

  /** impl: meter drain speed while countering, as a multiple of its fill speed at 1.0x. */
  meterDrainMultiplier: 1.0,

  // ─── Caught (DESIGN.md core rule 5) ───────────────────────────────────────
  caught: {
    /** Total time from being caught until the night restarts (the caught moment plays inside it). */
    pauseSec: 3,
    /** impl: seconds of caught moment before the screen cuts to black (inside pauseSec). */
    cutToBlackSec: 0.9,
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
  },

  flow: {
    /** impl: "Night N" card + darkness fade before the night clock starts. */
    nightIntroSec: 6,
    /** impl: shorter "Night N" lead-in when a night restarts after being caught. */
    restartIntroSec: 3,
    /** impl: pause after surviving a night before the next one starts. */
    nightClearedSec: 6,
    /** impl: how long a teaching hint stays scrawled near a threat's first attack. */
    teachingHintSec: 5,
  },

  audio: {
    /** impl: master volume of all game audio. */
    masterGain: 0.9,
    /** impl: how fast (s) game audio cuts out when the Listener arrives. */
    listenerCutSec: 0.12,
    /** impl: volume of the Listener's faint ringing (kept low so the mic barely hears it). */
    ringingGain: 0.025,
  },

  debug: {
    /** Overlay shown by default during development (M1). Override with ?debug=0 / ?debug=1. */
    overlayDefault: true,
    /** impl: overlay redraws per second. */
    overlayHz: 6,
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
