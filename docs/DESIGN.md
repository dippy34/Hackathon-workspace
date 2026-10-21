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
