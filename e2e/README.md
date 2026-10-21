# Emulator tests (no headset)

Plain Playwright + Chromium (SwiftShader) against the Vite dev server, which
injects Meta's IWER headset emulator on localhost. A quiet generated WAV stands
in for the microphone. The emulated room is IWER's `living_room` (2 windows,
no door, so the door placement fallback gets exercised).

```sh
npx vite --port 8195 --strictPort &       # dev server with IWER
node e2e/smoke.mjs                        # title -> mic -> XR -> calibration -> placement -> night 1
node e2e/caught.mjs                       # each threat catches you; the night restarts
node e2e/full-run.mjs                     # all 5 nights with an ideal-player autopilot (~13 min)
node e2e/resume.mjs                       # leave XR mid-night / after surviving, re-enter
node e2e/showcase.mjs                     # renders each monster (low danger, full danger, close-up, caught)
```

`autopilot.mjs` poses the emulated hands from the director's live state: hands
flat for Under the Desk, right-hand pinch aimed at the Peeker's face, left palm
toward the Knocker's door. Screenshots and the console log land in `e2e/out/`.
Software rendering runs at about 4-7 fps, so game time runs slower than real
time; that only makes the tests take longer.
