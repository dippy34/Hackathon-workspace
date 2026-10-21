# Hold Still: Game Design

> *A horror game where your body is the controller and your room is the map. No weapons. Just hold still.*

## The experience in one paragraph

You sit at your real desk wearing a Quest 3. The headset shows your actual room, then it slowly goes dark. Something scratches under your desk, so you press both hands flat and wait. A face appears at your real window, so you pinch to turn on your flashlight and stare it down. Then the room goes silent, and you know the Listener is close, so you don't make a sound. You survive five nights, each about two minutes, and each one harder than the last.

---

## Core rules

1. **You never move from your chair.** Everything happens at the desk or within view of it.
2. **You have no weapons.** You survive by **doing the right thing with your body.**
3. **Each threat has exactly one counter**, and the game teaches it once.
4. **The threats fight over your hands.** That's where the tension comes from.
5. **Getting caught costs one night, not the whole game.** After about a 3-second pause, that night restarts.

---

## The threats

Every threat uses the same **danger meter**:
- While it attacks and you're **not** countering, the meter **fills**. If it's full, you're caught.
- While you **are** countering, the meter **drains**, and after enough countered time the threat **leaves**.

The numbers below are starting values. Tune them in playtests.

### 🖐️ The Thing Under the Desk

| | |
|---|---|
| **Warning** | Scratching under the desk, from below the player |
| **Counter** | **Both hands flat on the desk** |
| **Counts as "flat"** | Palm within ~5 cm of the desk height measured in the intro, and facing down |
| **Caught after** | 1.5 s of not countering (enough time to slam your hands down) |
| **Leaves after** | 6 s of countering |
| **Average gap between attacks** | 25 s |
| **Caught moment** | A pale hand grabs from under the desk and the screen cuts to black |

### 🤫 The Listener

| | |
|---|---|
| **Warning** | **All sound in the game cuts out**, leaving a faint ringing. The silence itself is the signal. |
| **Counter** | **Stay quiet.** The room stays at its normal loudness. |
| **Caught after** | 0.3 s of noise (louder than 4× the room's normal level) |
| **Leaves after** | 8 s of quiet |
| **Average gap between attacks** | 30 s |
| **Caught moment** | Something screams back at you, right next to your ear |

Silencing all game audio during the Listener also keeps the mic from hearing the game's own sounds.

### 👁️ The Peeker

| | |
|---|---|
| **Warning** | Tapping on glass at one of your **real windows**; a pale face fades in outside |
| **Counter** | **Pinch to turn on the flashlight and keep the beam on the face** |
| **Caught after** | 8 s unlit; the face slowly comes *through* the glass |
| **Leaves after** | 2.5 s lit |
| **Average gap between attacks** | 20 s |
| **Flashlight battery** | 45 s per night. It refills between nights. |
| **Caught moment** | The face rushes at you |

### 🚪 The Knocker

| | |
|---|---|
| **Warning** | Your **real door's** handle rattles, then knocking |
| **Counter** | **Hold a palm out toward the door** (one hand is enough) |
| **Caught after** | 5 s; the door creaks open a little more each second |
| **Leaves after** | 4 s of palm held out |
| **Average gap between attacks** | 30 s |
| **Caught moment** | The door bursts open |

### Stretch threats (only if ahead of schedule)

- **👀 The Watcher:** it stands behind you and only moves while you're not looking at it. Turn around to freeze it, but then you aren't watching the windows.
- **🛏️ The Crawler:** it hides under your real bed or behind your real couch, using the room's furniture labels. Its rules are still to be decided.

---

## Fairness rules

Threats fight over your hands, which is fun until two of them want contradictory things at the same moment.

| Threat | Needs |
|---|---|
| Under the Desk | **Both** hands flat |
| Peeker | One hand pinching and pointing |
| Knocker | One hand palm-out |
| Listener | Nothing. It only needs silence, so it can overlap with anything. |

**The rule:** the game never starts an attack that **can't be survived** given what's already happening. If a hands-threat is attacking, another hands-threat can only start if its "caught after" time is longer than what's left of the first one's "leaves after" time, plus **1.5 s** to react. Otherwise it waits.

**No more than 2 attacks at once**, except on night 5, which allows 3 if the fairness rule passes.

---

## The nights

| Night | Threats | Aggression | Length |
|---|---|---|---|
| Intro | none; the calibration doubles as the tutorial | — | ~10 s |
| 1 | Under the Desk | 1.0× | 2 min |
| 2 | Under the Desk, Peeker | 1.0× | 2 min |
| 3 | + Listener | 1.15× | 2 min |
| 4 | + Knocker | 1.3× | 2 min |
| 5 | Everything | 1.6× | 2 min |

**Aggression** makes attacks come sooner and makes the danger meter fill faster.

A threat's first appearance in a night is a **teaching moment**. It always attacks alone, and it starts within 10 s of the night beginning.

### The intro

The text reads **"Put both hands flat on your desk. Stay quiet."** While the player does that, the game:
- records the desk height from where the palms are, and
- measures how loud the room normally is.

So the intro teaches the two core rules and calibrates the game at the same time.

### The ending

After night 5 the room lights back up to normal passthrough and a single line reads: **"You held still."**

---

## Look and sound

- **The dark room:** your real room fades to nearly black at night start, slowly enough that it feels like the lights going out. A stretch goal is to have the flashlight beam reveal the *real* room through the darkness.
- **The monsters stay mostly unseen:** eyes, fingers, a hand, a silhouette. That's scarier, and it needs far fewer 3D models.
- **The sound matters most.** Use positional audio, so scratching comes from *below* and knocking from the *door's real position*. Real recordings beat stock sounds.
- **No on-screen interface** during nights, except a small battery glow on the flashlight. The debug overlay in `BUILD_SPEC.md` is for development only.

---

## Comfort and accessibility

- Seated play with no movement, so nobody gets motion sick.
- A jumpscare warning on the title screen.
- **If the player denies microphone permission,** the Listener is turned off and the title screen says so.
- **If the game can't find a window or door in the room,** the intro asks the player to point at a wall and pinch to place them.

---

## Implementation notes (how the build reads this doc)

These are the places where the rules above needed an interpretation to be coded. They don't change any rule; they pin down cases the text leaves open. The code that enforces them is in `src/core/`, and every number lives in `src/config.ts`.

- **Danger meter.** It fills at `aggression ÷ caught-after` per second while you're not countering, and drains at `1 ÷ caught-after` per second while you are. "Leaves after" counts **total** countered time during the attack, so it doesn't need to be unbroken.
- **Teaching moment.** "First appearance in a night" is read as **the first attack on the night the threat is introduced**: Under the Desk on night 1, the Peeker on night 2, the Listener on night 3, the Knocker on night 4. (Read literally for every night, night 5 would need four solo attacks inside 10 s, which can't fit.) That attack starts between 4 and 9.5 s into the night. Nothing else starts before it or while it's active. It repeats when the night restarts.
- **Teaching hint.** During a teaching attack, a faint 2–3 word scrawl appears near the threat for 5 s ("Hands flat.", "Pinch. Light it.", "Palm out. Hold it.", "Shh. Not a sound."). It's the only text during nights besides the battery glow. Set `flow.teachingHintSec` to 0 to turn it off.
- **Fairness, in full.** A new hands-threat may start only if its "caught after" (divided by aggression) is longer than a "hands busy" budget. The budget is:
  - the **sum**, over every active hands-threat, of its remaining "leaves after" plus 1.5 s;
  - plus another 1.5 s if the player isn't countering any of them yet (they still have to react to the first one);
  - and never less than 1.5 s minus the time since the last hands-threat left (a hand may still be on its way back).

  With one active hands-threat that's being countered, this is exactly the rule above. The extra parts only make it stricter, so an attack that DESIGN.md allows can wait a little longer, but nothing it forbids can start. A simulated player that needs about 1 s to react and 1.4 s to move a hand survives every night in testing.
- **"Caught after" and aggression.** The fairness check uses `caught after ÷ aggression`, because aggression makes the meter fill faster.
- **Max attacks at once.** The Listener counts toward the limit of 2 (or 3 on night 5).
- **Night clock.** No new attack starts in the first 6 s or the last 4 s of a night, except the teaching attack. When the clock hits 2:00 you've survived, and any attacks still active simply end.
- **Caught.** The caught moment plays for about 0.9 s, then the screen cuts to black and shows "Night N. Again." The night clock restarts 3 s after the catch (1.8 s caught + black, then a 1.2 s lead-in).
- **No mic.** The Listener is removed from the schedule. Night 3 still runs with Under the Desk and the Peeker.
- **Every warning has a sound and a visual,** so a threat that starts during the Listener's silence can still be seen.
- **Leaving XR** (taking the headset off, or exiting through the Quest menu) pauses the game. Coming back replays the current night from its start, or starts the next one if you'd just survived. The headset menu (blur) only pauses. If the microphone was allowed after the intro, the intro's hands-flat, stay-quiet step runs again first so the Listener has a room level.
- **Tracking loss.** A hand that loses tracking keeps its last state (flat, palm, pinch) as BUILD_SPEC asks. The one exception: a pinch lets go after 2 s without tracking, so a hand that leaves view mid-pinch can't leave the flashlight burning forever.
- **Open-plan rooms.** Quest reports Space Setup's invisible walls with the label "window". A "window" at least 2.3 m tall is treated as an invisible wall and ignored. It still shows in the debug overlay's label list.

### Implementation tuning (starting values; change in `src/config.ts`)

| Value | Starting value | What it does |
|---|---|---|
| `hands.flatPalmDownMaxAngleDeg` | 40° | Palm counts as "facing down" |
| `hands.palmFacingMaxAngleDeg` | 40° | Palm counts as "out toward the door" |
| `hands.palmOutMinAboveDeskM` | 8 cm | A palm-out hand must be off the desk |
| `hands.pinchStartM` / `pinchEndM` | 2 cm / 4 cm | Pinch on / off (hysteresis) |
| `mic.baselineFloorRms` | 0.004 | Very quiet rooms never get a hair-trigger threshold |
| `mic.levelSmoothingSec` | 0.05 s | Mic level smoothing |
| `threatFx.listener.onsetGraceSec` | 0.25 s | After the game audio cuts out (`audio.listenerCutSec`, 0.12 s), the Listener ignores the mic this much longer, so the game's own fading sound never counts as noise |
| `flashlight.beamHalfAngleDeg` | 14° | Beam cone that counts as "on the face" |
| `flashlight.beamRangeM` | 9 m | Beam reach |
| `intro.holdSec` | 3 s | Hands flat and still this long to calibrate |
| `intro.handsLevelToleranceM` | 6 cm | The two palms must be this level with each other |
| `intro.roomScanTimeoutSec` | 4 s | Wait this long for the room scan before asking for placement |
| `scheduler.gapJitterMin` / `Max` | 0.5× / 1.5× | Random spread around each average gap |
| `scheduler.quietOpeningSec` / `quietClosingSec` | 6 s / 4 s | No new attacks right at the start or end of a night |
| `darkness.fadeInSec` / `nightOpacity` | 6 s / 0.94 | Lights going out |
| `flow.nightIntroSec` / `nightClearedSec` | 6 s / 6 s | Transitions |
| `caught.cutToBlackSec` | 0.9 s | Caught moment before the cut to black |
| `caught.pauseSec` + `flow.restartIntroSec` | 1.8 s + 1.2 s | "About a 3-second pause" before the night restarts |
| `meterDrainMultiplier` | 1.0 | Meter drains as fast as it fills (at 1.0×) |
| `scheduler.teachingStartEarliestSec` | 4 s | Earliest a teaching attack starts (darkness settles first) |
| `maxFrameSec` | 0.1 s | A frame hitch slows game time instead of skipping ahead |
| `intro.holdGraceSec` | 0.35 s | Calibration forgives a hand flickering out of tracking this long |
| `intro.calibratedBeatSec` | 1.4 s | Pause on "Good." before the next intro step |
| `hands.pinchLostGraceSec` | 2 s | A pinch held by a hand that lost tracking lets go after this |
| `hands.speedWindowSec` | 0.25 s | Palm stillness is measured over this window (ignores tracking jitter) |
| `intro.stillMaxSpeedMps` | 0.12 m/s | Palms count as "still" for calibration |
| `room.maxWindowHeightM` | 2.3 m | Taller "windows" are invisible walls (open-plan rooms) |
