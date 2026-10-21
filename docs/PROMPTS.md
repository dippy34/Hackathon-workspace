# Prompts for Claude Code

Copy and paste these exactly. They are deliberately short: **the docs hold all the details**, so the prompts can't contradict them.

---

## 1. Kickoff (paste once, at the start)

```
You're building "Hold Still", a mixed reality horror game for Meta Quest 3, made as a web app (WebXR) for the Meta VR Start Developer Competition 2026.

The docs in this repo are the source of truth:
- docs/DESIGN.md: what the game is
- docs/BUILD_SPEC.md: how to build it, the milestones, and what's locked vs. open for creativity
- docs/PLAN.md: the schedule and the bigger picture

Read all three before writing any code. If anything in this message seems to disagree with the docs, the docs win. Point out the conflict to me instead of guessing.

Build milestone M1 only. When its "done when" check passes (as far as you can test without my headset), stop and send me a report with:
1. The HTTPS link to open on my Quest 3
2. Step-by-step what to check in the headset
3. Anything you could not verify without a real headset
4. Decisions you made that I should know about, and any ideas you'd pitch for later

You have real creative freedom in the "Open for creativity" column of BUILD_SPEC.md. Make those parts great. Don't change anything in the "Locked" column, and don't add features beyond the docs; pitch those ideas in your report instead.

If you change a tuning value or make a decision the docs should reflect, update the doc in the same commit. Ask me before doing anything that needs my accounts or passwords.
```

---

## 2. Next milestone (paste after each milestone passes on your headset)

Change the milestone numbers and add your notes:

```
M1 passed on my headset. My notes from testing: [what felt good, what felt off, anything broken].

Now build milestone M2 from docs/BUILD_SPEC.md. Same rules as before: the docs are the source of truth, stop when the "done when" check passes, and send me the same 4-part report.
```

---

## 3. Something's broken

```
On the headset I did [what you did]. I expected [what should happen] but got [what actually happened].

Find the root cause before changing any code, then fix it and give me exact steps to re-test.
```

---

## 4. Playtest feedback (use for M3)

```
Here's playtest feedback from [number] people: [paste notes].

Fix what's in scope for milestone M3 in docs/BUILD_SPEC.md. For anything that would change the "Locked" column, list it as a pitch instead of building it.
```
