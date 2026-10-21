# Hold Still: Build Spec (for the coding agent)

[`DESIGN.md`](DESIGN.md) says **what** the game is. This file says **how** to build it and **in what order**.

**Numbers live in one place.** Every timing and tuning value is in `DESIGN.md`, so read it from there. If you change a value after testing, update `DESIGN.md` in the same commit.

---

## Hard requirements (never break these)

1. **It's a web app.** It runs in the **Meta Quest Browser** on a **Quest 3 / 3S** using WebXR, as an `immersive-ar` session for passthrough.
2. **Hands only.** No step may ever need a controller.
3. **Seated.** Everything must work from a desk chair.
4. **60fps minimum** in the Quest Browser (aim for 72).
5. **Every tuning value is easy to change in one config place.** No timings buried in code.
6. **Build one milestone at a time.** Stop at the end of each one and report to the human.
7. **No features beyond this spec and `DESIGN.md`.** Pitch new ideas in your report instead.

---

## Locked vs. open for creativity

| 🔒 Locked: don't change | 🎨 Open: your call, make it great |
|---|---|
| The hard requirements above | How the monsters look (keep them mostly unseen) |
| The core rules in `DESIGN.md` | Sound design and how each warning *feels* |
| The four threats and **their counters** | The caught moments and jumpscares |
| The fairness rules | The title screen, the ending, transitions |
| The five nights and which threats are in each | The dark-room effect and the flashlight look |
| The milestone order and scope | Code structure, file names, internal design |
| | Starting tuning values, as long as you update `DESIGN.md` |
| | Small "juice": subtle effects that make it feel better without adding features |

If an idea would change something on the locked side, put it in your report as a pitch. Don't build it.

---

## Platform

| Thing | Choice |
|---|---|
| Framework | **Meta Immersive Web SDK (IWSDK)**, which is Three.js plus an Entity Component System. Start from its official project scaffold. |
| Language | TypeScript |
| Session | WebXR `immersive-ar` with hand tracking; plane detection, mesh detection and anchors where available |
| Testing without a headset | IWSDK's **IWER emulator** in a desktop browser |
| Testing on the headset | An **HTTPS link** opened in the Quest Browser |
| Hosting | Any free HTTPS static host that deploys automatically on push, such as GitHub Pages, Netlify or Vercel. The human must get a working link every milestone. |
| Microphone | Web Audio API with `getUserMedia`, measuring loudness only. Nothing is recorded, saved or sent anywhere. |
| Docs | Meta's IWSDK documentation is the authority. Check it instead of guessing APIs. |

**Don't** package it as a store app (PWA or otherwise) unless the human confirms the competition rules need it.

---

## What the game needs to know (suggested modules)

The names and structure here are suggestions, so organize the code however you think is best. The **behavior** is what matters.

| Module | Must do |
|---|---|
| **Game flow** | Title screen → intro (doubles as calibration) → nights 1–5 → ending. On caught: a short pause, then restart the current night. |
| **Attack scheduler** | Decides when each active threat attacks, and enforces **all fairness rules** in `DESIGN.md`. |
| **Threat (shared logic)** | The **danger meter** described in `DESIGN.md`. Each threat only defines *"is the player countering me right now?"* plus its own visuals and sound. |
| **The four threats** | Under the Desk, Listener, Peeker, Knocker, exactly as `DESIGN.md` describes. |
| **Hands** | Detects "both hands flat on the desk" using the desk height from the intro. Detects "palm facing a point" for the Knocker, and the pinch for the flashlight. **If a hand loses tracking, keep its last state** instead of counting it as lifted. |
| **Mic** | Live loudness level, the room's normal noise level from the intro, and graceful handling if permission is denied (see `DESIGN.md`). |
| **Flashlight** | On while pinching, with the battery from `DESIGN.md`. Answers "is this point inside the beam?" |
| **Room** | Finds real windows and doors from scene understanding. **Label support in the Quest Browser is unverified**, so log what labels the headset actually reports. If no window or door is found, use the point-and-pinch placement from `DESIGN.md`. |
| **Dark room** | WebXR can't dim passthrough directly, so draw a darkness layer around the player that fades in at night start. Stretch: the flashlight cuts a soft hole in it, revealing the real room. |
| **Debug overlay** | Floating text above the desk with hand states, mic level vs threshold, battery, each threat's danger %, and what the room scan found. Visible in development, hidden in release. |

---

## Milestones

Stop after each milestone and send the human the report described in [`PROMPTS.md`](PROMPTS.md). The target dates match [`PLAN.md`](PLAN.md).

### M1: The whole game, basic version (target: Nov 4)

**Everything in `DESIGN.md` except the stretch threats**, fully playable start to finish. Function comes first: simple placeholder looks and sounds are fine, and the extras come in M2.

M1 is big, so **build it in this order and commit as you go**. Each step leans on the ones before it.

1. **Setup:** IWSDK project, auto-deploy to an HTTPS link, an `immersive-ar` session with passthrough and hand tracking.
2. **Debug overlay** (from the module table), so every later step can be seen working.
3. **The senses:**
   - Room scan, logging every plane and mesh label the headset reports, with window and door markers or the placement fallback.
   - Hands: desk calibration, flat detection, palm-facing, pinch.
   - Mic: permission, live level, denied handling.
4. **Flashlight** (pinch, battery) and the **dark room** fade. A basic fade only; the reveal effect is M2.
5. **Shared threat logic** (the danger meter) and the **attack scheduler** with every fairness rule, including "a threat's first appearance attacks alone".
6. **All four threats:** Under the Desk, Listener, Peeker, Knocker. Placeholder visuals are fine (glowing eyes, a simple hand, a door glow). Each has a placeholder **spatial** sound coming from the right place: under the desk, the window, the door. The Listener's silence works for real.
7. **Game flow:** a simple title screen (with the jumpscare warning and mic-off notice), the intro that calibrates, **all 5 nights**, caught → pause → restart night, and a simple ending.

**Done when:** on the Quest 3, the human opens the link and plays **all 5 nights start to finish, hands only**. They can survive and get caught by each of the four threats, getting caught restarts the night, and no impossible overlaps happen. The debug overlay shows what the room scan found and whether the mic hears the game's own sounds.

### M2: The extras (target: Nov 11)

Make it scary and impressive. This is where most of the "Open for creativity" column happens.

- **Real monster looks:** models and animations, still mostly unseen (eyes, fingers, silhouettes).
- **Real sound design:** swap in the human's recordings and free sounds, make warnings sound distinct, add ambience.
- **Caught moments:** a proper jumpscare for each threat.
- **The flashlight-reveal effect:** the beam cuts through the darkness and shows the real room. Spend **no more than ~1 day** on it; if it fights you, keep the basic fade.
- **Title screen, ending and transitions:** polished, with small "juice" touches.
- **Stretch:** the Watcher (see `DESIGN.md`). The Crawler only after its rules are written into `DESIGN.md`, so pitch rules first.

**Done when:** a friend plays all 5 nights with no help beyond the intro, and gets scared at least once.

### M3: Ship check (target: Nov 14)

- Steady **60fps or better** in the Quest Browser through night 5.
- Fix what came up in the human's playtests.
- Debug overlay hidden in the release build.
- One last full playthrough, hands only.

**Done when:** the release link runs at 60fps or more through night 5, and a full playthrough works hands-only.

---

## Performance budget
- At most one real-time light, used for the flashlight; fake it with a shader if that's cheaper. Everything else unlit or baked.
- No real-time shadows.
- Low-poly models, compressed textures and models. The monsters are mostly in darkness anyway.
- Keep the scene-understanding debug visuals off outside of debug mode.

## Testing rules
- Test everything you can in the emulator before handing off.
- **Say plainly what you could not verify** without a real headset, such as the mic, the real room or hand feel, and give the human exact steps to check it.
