# Hold Still: Build Spec (for the coding agent)

This is the technical spec for building **Hold Still**. Read [`DESIGN.md`](DESIGN.md) first; it explains *what* the game is. This file explains *how* to build it and in what order.

## Hard requirements (never break these)

1. **Hands only.** No step of the game may ever need a controller.
2. **Seated.** Everything must work from a desk chair.
3. **60fps minimum** on Quest 3 / 3S (aim for 72).
4. **Every tuning number is editable in the Unity Inspector.** Don't hard-code timings.
5. **Build one milestone at a time** and test it on the headset before starting the next.
6. **No features beyond this spec** unless the human asks for them.

## Platform

| Thing | Choice |
|---|---|
| Engine | Unity, the version Meta's latest (v207) SDK docs recommend, with Android Build Support |
| Headset | Meta Quest 3 / 3S (needs color passthrough) |
| Meta SDKs | Meta XR **Core** SDK (camera rig, hand tracking, passthrough), **Interaction** SDK (hand rig), **MR Utility Kit** (room data) |
| Agent tooling | Meta's `metavr` CLI (`metavr init`) for documentation and device debugging |
| Development machine | **Mac**. Quest Link is Windows-only, so test with **Build and Run over USB**. Use the Meta XR Simulator for quick checks if your version supports Mac. |
| Permissions | Microphone, Scene (`com.oculus.permission.USE_SCENE`), hand tracking |

## Architecture

Keep each script small and doing one job.

| Component | Job |
|---|---|
| **GameManager** | Runs the intro (which doubles as calibration), then nights 1–5 in order. On "caught", waits 3 s and restarts the current night. Fires events: night started, night survived, player caught, game won. |
| **AttackScheduler** | Decides when each active threat attacks. Applies the **fairness rules** and the 2-attacks-at-once limit from `DESIGN.md`, and the "first appearance attacks alone" rule. |
| **Threat** (base class) | The **danger meter**: fills while not countered (scaled by aggression), drains while countered, the threat leaves after "survive seconds" of countering, and catches the player at 100%. Subclasses only define *"is the player countering me?"* plus visuals and sound. |
| **UnderDeskThreat** | Countered when `PlayerHands` reports both hands flat. |
| **ListenerThreat** | Countered while the mic level is under the threshold. Mutes all other game audio while attacking. |
| **PeekerThreat** | Spawns at a random real window. Countered while the flashlight beam is on the face. |
| **KnockerThreat** | Spawns at a real door. Countered while either palm faces the door. |
| **PlayerHands** | Desk height from the intro calibration. "Flat" means the palm is within ±5 cm of desk height and facing down. **If a hand loses tracking, keep its last state** instead of counting it as lifted. Also answers "is either palm facing point X?" |
| **MicLoudness** | Reads the room's loudness (a running average, nothing recorded or saved) and measures the room's normal noise level during the intro. Handles the Android microphone permission. |
| **Flashlight** | Attached to a hand: on while pinching, battery drains while on and refills each night. Answers "is point X inside the beam?" |
| **RoomFinder** | Uses the MR Utility Kit to get the positions of **WINDOW_FRAME** and **DOOR_FRAME** (later also TABLE, BED, COUCH). If none are marked, falls back to a "point and pinch to place" step in the intro. |
| **DarkRoom** | Dims passthrough to near-black at night start and back at the end. Stretch: the flashlight reveals the real room. |
| **DebugOverlay** | Floating text above the desk: hands flat for each hand, mic level and threshold, battery, each threat's danger %, room data counts. Toggled on in development builds. |

## Milestones

Each milestone has a "done when" check. **Don't move on until it passes on the real headset.**

### M1 — Foundation (target: Nov 1)
- Unity project with Meta XR SDKs; hand tracking + passthrough running on Quest 3 via Build and Run.
- `RoomFinder` puts a debug cube on each real window and door.
- `PlayerHands` with intro calibration; `MicLoudness` with permission handling.
- `DebugOverlay` showing all of the above.
- **Test the mic:** play loud game sound, and record whether the mic level jumps.
- Allow **at most 1 day** for the DarkRoom flashlight-reveal effect, otherwise use plain dimming.

**Done when:** in the headset you see cubes on your real window and door, the overlay correctly says when each hand is flat, and the mic level jumps when you talk.

### M2 — The core loop (target: Nov 5)
- `Threat` base, `GameManager`, `AttackScheduler`.
- `UnderDeskThreat` and `ListenerThreat` with placeholder sounds.
- Nights 1 and 3 playable (night 3 temporarily without the Peeker); catch → restart works.

**Done when:** you can survive and get caught by both threats, and getting caught restarts the night.

### M3 — Peeker and the full first half (target: Nov 8)
- `Flashlight` (pinch, battery) and `PeekerThreat` at real windows.
- Nights 1–3 as designed.

**Done when:** a friend plays nights 1–3 hands-only without help, after only the intro.

### M4 — Complete game (target: Nov 12)
- `KnockerThreat`, nights 4–5, fairness rules fully on.
- Title screen (with jumpscare warning and mic-off notice), the ending, and caught-moment jumpscares.
- Positional audio for every threat, plus real sound recordings.

**Done when:** the full 5 nights can be played start to finish and no impossible overlaps happen.

### M5 — Polish and performance (target: Nov 14)
- Steady 60fps or better, checked with Meta's Device Readiness Check.
- Playtest fixes from at least 3 new players.
- Debug overlay off in release build.
- Stretch only if everything above is done: The Watcher.

**Done when:** a release build runs at 60fps or more through night 5 and passes the Device Readiness Check.

## Performance budget
- One real-time light (the flashlight). Everything else is unlit or baked.
- No real-time shadows.
- Low-poly models and small textures. The monsters are mostly in darkness anyway.

## Prompts for your coding agent

Paste these one at a time, and only start the next after the previous milestone's "done when" passes.

1. *"Read `docs/DESIGN.md` and `docs/BUILD_SPEC.md`. Set up a Unity project for Meta Quest 3 with the Meta XR Core SDK, Interaction SDK and MR Utility Kit. I develop on a Mac, so plan for Build and Run over USB. Then build milestone M1. Stop when M1 is done and tell me exactly how to test it on my headset."*
2. *"M1 passed. Build milestone M2 from `docs/BUILD_SPEC.md`. Keep every timing in the Inspector."*
3. *"M2 passed. Build milestone M3."*
4. *"M3 passed. Build milestone M4. Follow the fairness rules in `docs/DESIGN.md` exactly."*
5. *"M4 passed. Do milestone M5: performance and polish. Here's the playtest feedback: …"*

If something breaks: *"This happened on the headset: [describe]. Here's the log: [paste]. Find the cause before changing code."*
