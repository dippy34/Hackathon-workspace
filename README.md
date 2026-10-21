# Hold Still

*A horror game where your body is the controller and your room is the map. No weapons. Just hold still.*

A mixed reality game for Meta Quest 3 / 3S, built as a **web app (WebXR)** that runs in the Quest Browser, for the **Meta VR Start Developer Competition 2026** (Gaming track). Submission target: **Nov 16, 2026**.

| Doc | What's in it |
|---|---|
| [docs/PLAN.md](docs/PLAN.md) | Master plan: schedule, to-do lists, assets, trailer, submission |
| [docs/DESIGN.md](docs/DESIGN.md) | Game design: threats, rules, nights, sound |
| [docs/BUILD_SPEC.md](docs/BUILD_SPEC.md) | Build spec: platform, milestones, locked vs. open for creativity |
| [docs/PROMPTS.md](docs/PROMPTS.md) | The prompts to paste into Claude Code |

## Play it

Open this link in the **Meta Quest Browser** on a Quest 3 / 3S. It redeploys automatically on every push:

**https://raw.githack.com/dippy34/Hackathon-workspace/claude/stoic-brown-rb8ej1/site/index.html**

Add `?debug=0` to hide the debug overlay, or `?debug=1` to force it on.

## Develop

```sh
npm install
npm run typecheck   # always before testing
npm test            # rules engine: danger meter, fair scheduler, game flow (Node, no headset)
npm run dev         # IWSDK dev server + IWER headset emulator (needs a display; see AGENTS.md)
npm run build:site  # production build into site/ (CI does this on every push)
```

- `src/config.ts`: every timing and tuning value (mirrors `docs/DESIGN.md`).
- `src/core/`: pure rules engine (no Three/DOM), fully unit-tested.
- `src/game/`: the director (game loop), the intro/calibration, and the module contracts.
- `src/senses/`: hands, mic, room scan. `src/audio/`: procedural spatial sound. `src/fx/`: darkness, flashlight, text. `src/threats/`: the four threats. `src/debug/`: the overlay. `src/ui/`: the 2D title page.
