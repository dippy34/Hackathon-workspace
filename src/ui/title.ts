import { CONFIG } from '../config.js';
import type { MicStatus, TitleController, TitleHandlers } from '../game/contracts.js';
import './title.css';

const TEXT = {
  pending: 'Listening for your microphone…',
  granted: 'Microphone ready. Loudness only — nothing is recorded or sent anywhere.',
  off: 'Microphone is off, so the Listener is turned off. You can still play.',
  noXR: 'This needs the Meta Quest Browser on a Quest 3 or 3S',
  retry: 'Try the microphone again',
} as const;

const MARKUP = /* html */ `
<div class="hs-vignette" aria-hidden="true"></div>
<div class="hs-grain" aria-hidden="true"></div>
<main class="hs-page">
  <header class="hs-head">
    <h1 class="hs-logo" aria-label="Hold Still"><span class="hs-logo-word">HOLD</span> <span class="hs-logo-word">STILL</span></h1>
    <p class="hs-tagline">Your body is the controller. Your room is the map. No weapons. Just hold still.</p>
  </header>

  <div class="hs-info">
    <section class="hs-warning" aria-labelledby="hs-warning-title">
      <h2 id="hs-warning-title">Jumpscare warning</h2>
      <p>This game has <strong>sudden loud sounds</strong> and <strong>frightening images</strong>.</p>
      <p class="hs-facts">Seated play <span aria-hidden="true">·</span> 5 nights <span aria-hidden="true">·</span> about 10–12 minutes</p>
    </section>

    <section class="hs-before" aria-labelledby="hs-before-title">
      <h2 id="hs-before-title">Before you start</h2>
      <ul>
        <li>Sit at your desk.</li>
        <li>Finish Space Setup with your windows and door marked.</li>
        <li>Play with your hands only — put the controllers down.</li>
        <li>Headphones on, or speaker volume up.</li>
      </ul>
    </section>
  </div>

  <section class="hs-steps" aria-label="Start the game">
    <p class="hs-resume" data-role="resume" hidden></p>
    <button type="button" class="hs-btn hs-begin" data-role="begin">
      <span class="hs-btn-num" aria-hidden="true">1</span><span class="hs-btn-label">Begin</span>
    </button>
    <p class="hs-status hs-mic" data-role="mic" aria-live="polite" hidden></p>
    <button type="button" class="hs-btn hs-btn-primary hs-enter" data-role="enter" disabled>
      <span class="hs-btn-num" aria-hidden="true">2</span><span class="hs-btn-label">Enter the room</span>
    </button>
    <p class="hs-status hs-xr" data-role="xr" aria-live="polite" hidden></p>
  </section>

  <footer class="hs-foot">Made for the Meta VR Start Developer Competition 2026</footer>
</main>`;

/**
 * The 2D title page shown in the Quest Browser before entering XR. Two big
 * pinch-friendly steps: "Begin" (audio + mic, a user gesture) then "Enter the
 * room" (launches XR synchronously inside its own click).
 */
export function mountTitle(root: HTMLElement, handlers: TitleHandlers): TitleController {
  root.classList.add('hs-title');
  root.innerHTML = MARKUP;

  const el = <T extends HTMLElement>(role: string): T => root.querySelector<T>(`[data-role="${role}"]`)!;
  const begin = el<HTMLButtonElement>('begin');
  const beginLabel = begin.querySelector<HTMLElement>('.hs-btn-label')!;
  const beginNum = begin.querySelector<HTMLElement>('.hs-btn-num')!;
  const enter = el<HTMLButtonElement>('enter');
  const micLine = el<HTMLParagraphElement>('mic');
  const xrLine = el<HTMLParagraphElement>('xr');
  const resumeLine = el<HTMLParagraphElement>('resume');

  let xrSupported = true;
  /** Step 1 has answered (or the mic prompt took too long): step 2 may unlock. */
  let micAnswered = false;
  let pending = false;
  let graceTimer = 0;

  const say = (line: HTMLElement, text: string | null, tone?: 'ok' | 'off' | 'wait'): void => {
    line.hidden = !text;
    line.textContent = text ?? '';
    line.dataset.tone = tone ?? '';
  };

  const refreshEnter = (): void => {
    const ready = xrSupported && micAnswered;
    enter.disabled = !ready;
    enter.classList.toggle('hs-ready', ready);
  };

  const setMicStatus = (s: MicStatus): void => {
    window.clearTimeout(graceTimer);
    pending = s === 'requesting';
    begin.setAttribute('aria-busy', String(pending));
    begin.classList.toggle('hs-pending', pending);
    switch (s) {
      case 'requesting':
        say(micLine, TEXT.pending, 'wait');
        begin.disabled = true;
        break;
      case 'granted':
        say(micLine, TEXT.granted, 'ok');
        micAnswered = true;
        begin.disabled = true;
        begin.classList.add('hs-done');
        beginLabel.textContent = 'Begin';
        beginNum.textContent = '✓';
        break;
      case 'denied':
      case 'unavailable':
        say(micLine, TEXT.off, 'off');
        micAnswered = true;
        begin.disabled = false; // let the player try again (e.g. after allowing it in settings)
        beginLabel.textContent = TEXT.retry;
        break;
      case 'idle':
        say(micLine, null);
        begin.disabled = false;
        break;
    }
    refreshEnter();
  };

  begin.addEventListener('click', () => {
    if (pending) return;
    setMicStatus('requesting');
    // If the permission prompt never answers, don't strand the player on this page.
    graceTimer = window.setTimeout(() => {
      micAnswered = true;
      refreshEnter();
    }, CONFIG.title.micGraceSec * 1000);
    // Called synchronously so audio resume + getUserMedia keep this click's user activation.
    let result: Promise<MicStatus>;
    try {
      result = handlers.onBegin();
    } catch (e) {
      console.warn('[title] onBegin failed', e);
      result = Promise.resolve<MicStatus>('unavailable');
    }
    result.then(setMicStatus, (e: unknown) => {
      console.warn('[title] onBegin rejected', e);
      setMicStatus('unavailable');
    });
  });

  enter.addEventListener('click', () => {
    if (enter.disabled) return;
    handlers.onEnter(); // sync: requestSession needs this click's user activation
  });

  return {
    setMicStatus,
    setXRSupport(supported: boolean, detail?: string): void {
      xrSupported = supported;
      if (supported) say(xrLine, null);
      else {
        say(xrLine, TEXT.noXR, 'off');
        if (detail) {
          const small = document.createElement('small');
          small.textContent = detail;
          xrLine.append(small);
        }
      }
      refreshEnter();
    },
    setResume(text: string | null): void {
      say(resumeLine, text);
    },
    show(): void {
      root.hidden = false;
      (enter.disabled ? begin : enter).focus({ preventScroll: true });
    },
    hide(): void {
      root.hidden = true;
    },
  };
}
