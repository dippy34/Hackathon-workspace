# Hold Still: Master Plan

**Pitch:** *A horror game where your body is the controller and your room is the map. No weapons. Just hold still.*

| Doc | What's in it | Who it's for |
|---|---|---|
| **PLAN.md** (this file) | Schedule, to-do lists, assets, trailer, submission | You |
| [DESIGN.md](DESIGN.md) | The game itself: threats, rules, nights, sound | You + the coding agent |
| [BUILD_SPEC.md](BUILD_SPEC.md) | How to build it, milestones, prompts to paste | The coding agent |

**Competition:** Meta VR Start Developer Competition 2026, **Gaming** track (top prize $100K).
Also eligible for special awards: **Best Passthrough** ($25K) and **10-Minute Challenge** ($20K). Each entry can win only one prize.

---

## Key dates

| Date | What |
|---|---|
| **Now → laptop back** | Week 0: setup you can do from your phone and headset |
| Nov 1 | M1: foundation working on the headset |
| Nov 5 | M2: the core loop (Under the Desk + Listener) |
| Nov 8 | M3: Peeker, nights 1–3 |
| Nov 12 | M4: full game, 5 nights |
| Nov 14 | M5: polish + 60fps |
| Nov 15 | Record and cut the trailer |
| **Nov 16** | **Submit** (our target) |
| Nov 18, 8pm UTC | Real deadline. Keep these 2 days as buffer only. |
| Dec 11 | Winners announced |

---

## Week 0: do these now, no laptop needed

- [ ] **Check which Quest you have.** You need a **Quest 3 or 3S**, because the Quest 2's passthrough is black and white.
- [ ] **Join the Meta VR Start program.** You can't submit without it.
- [ ] **Register** on the Devpost competition page, and **read the official rules** there.
- [ ] **Turn on Developer Mode** for your headset in the Meta Horizon phone app. You'll have to create a free developer organization.
- [ ] **In the headset, run Space Setup** in your test room, and make sure your **windows, door and desk** are marked.
- [ ] **Record sounds on your phone:** scratching under your desk, knocking on your door, tapping on your window, slow breathing. Real recordings are scarier than stock ones.
- [ ] **Bookmark free assets** (see below).
- [ ] **Tune the rules with a friend:** have them be the monster. They scratch under the desk and you slam your hands down; they knock and you hold your palm out. Time how long reactions take and update the numbers in `DESIGN.md`.

---

## How to work with the coding agent

1. Give it `DESIGN.md` and `BUILD_SPEC.md`.
2. Paste the **prompts at the bottom of `BUILD_SPEC.md`**, one milestone at a time.
3. **After each milestone, put on the headset and check the "done when" line.** If it fails, don't move on.
4. Describe bugs exactly: what you did, what you expected, what happened. Include the log if you have it.
5. If you fall behind, cut features in the order listed below. Don't skip the testing.

### If you fall behind, cut in this order
1. Stretch threats (the Watcher, the Crawler)
2. The flashlight-reveals-your-room effect (use plain dimming)
3. The Knocker (go to 4 nights)
4. Night 5

**Never cut:** Under the Desk, the Listener, and the sound. Those are the game.

---

## Free assets

Monsters stay mostly **unseen** (eyes, fingers, a hand), so you need very few models.

| Need | Where |
|---|---|
| Creature models + animations | Mixamo (free with an Adobe account), Unity Asset Store free horror packs, Sketchfab (filter: downloadable + Creative Commons) |
| Sound effects | freesound.org (filter CC0), Sonniss free game audio bundles, **your own recordings** |
| Fonts | Google Fonts |

Keep a `CREDITS.md` with every asset and its license as you go.

---

## The trailer (Nov 15)

The rules require **under 3 minutes**, **real headset footage** (no AI-generated video), and public on YouTube or Vimeo.

| Time | Shot |
|---|---|
| 0:00–0:05 | **Hook:** someone screams and instantly gets caught by the Listener |
| 0:05–0:15 | Title card: *"Hold Still. Your body is the controller. Your room is the map."* |
| 0:15–1:15 | One threat each: the desk hands, the window face + flashlight, the silence, the door palm |
| 1:15–1:45 | Night 5 chaos: two threats at once, with the player choosing |
| 1:45–2:15 | A friend's real reaction, shown side by side (outside camera + headset view) |
| 2:15–2:30 | "Hands only. Seated. Your real room." End card. |

Record the headset view with the Quest's built-in recorder. Film a player from outside with your phone too.

---

## Devpost submission checklist (Nov 16)

- [ ] Trailer link (YouTube or Vimeo, public, under 3 min)
- [ ] Build uploaded the way the official rules say
- [ ] Description: pitch, the four threats, which Quest features each uses
- [ ] Screenshots: window face, hands on desk, dark room
- [ ] Track: **Gaming**; mention passthrough and the 10-minute length
- [ ] Credits for every asset
- [ ] Tested start to finish **hands only** one last time on the release build

---

## How we score on each judging criterion

These criteria come from an unofficial copy of the rules. Confirm on Devpost.

| Criterion | What we show |
|---|---|
| Innovation & Creativity | Four threats, each beaten with a different part of your body; your real room is the map |
| Experience Design | Seated, hands-only, ~10 min, a wordless tutorial, restart per night |
| Technical Implementation | Hand tracking, mic, room scanning (windows/door/desk), passthrough, 60fps |
| Polish & Presentation | Sound design, mostly unseen monsters, the "scream and die" trailer hook |

---

## Risks

| Risk | Plan |
|---|---|
| The mic hears the game's own sounds | All game audio cuts out during the Listener (that's also its warning). Test in M1. |
| A hand leaves camera view when you look at a window | The game keeps that hand's last state instead of counting it as lifted |
| Quest Link doesn't work on Mac | Build and Run over USB for every test, so budget the extra minutes |
| The player hasn't marked windows or a door | The intro lets them point and pinch to place them |
| The flashlight-reveal effect is too hard | Allow 1 day, then fall back to plain dimming |
| Dropping below 60fps | One real-time light, no real-time shadows, low-poly models. Check every milestone. |
| Behind schedule | Follow the cut list. Submit on the 16th no matter what. |
