import { NIGHT_COUNT, type ThreatId } from '../config.js';
import type { Phase } from '../core/types.js';
import type { Director } from '../game/director.js';
import { Pilot, type HandsMode, type IwerDevice } from './pilot.js';

// Desktop preview only (site/preview/): the control panel over IWER's emulated Quest 3.

const NAMES: Record<ThreatId, string> = { underDesk: 'Under the Desk', listener: 'Listener', peeker: 'Peeker', knocker: 'Knocker' };
const PHASES: Record<Phase, string> = {
  title: 'title page',
  intro: 'intro',
  nightIntro: 'lights out',
  night: 'quiet',
  caught: 'caught',
  nightCleared: 'survived',
  ending: 'the end',
};

const CSS = `
.hsp{position:fixed;top:12px;right:12px;z-index:2147483000;width:260px;max-width:calc(100vw - 24px);box-sizing:border-box;
  background:rgba(10,12,16,.92);color:#e4dccc;border:1px solid rgba(228,220,204,.18);border-radius:10px;
  font:13px/1.45 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif;box-shadow:0 6px 24px rgba(0,0,0,.5)}
.hsp *{box-sizing:border-box}
.hsp-head{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 10px}
.hsp-head strong{font-size:13px;letter-spacing:.04em}
.hsp-body{padding:0 10px 10px}
.hsp [hidden]{display:none!important}
.hsp p{margin:0 0 8px}
.hsp-note{color:#a39d91;font-size:12px}
.hsp-label{display:block;margin:10px 0 4px;color:#a39d91;font-size:11px;text-transform:uppercase;letter-spacing:.08em}
.hsp button{font:inherit;color:inherit;background:#171b22;border:1px solid rgba(228,220,204,.22);border-radius:6px;padding:6px 8px;cursor:pointer}
.hsp button:hover:not(:disabled){border-color:#c98a3e}
.hsp button:disabled{opacity:.4;cursor:default}
.hsp button[aria-pressed=true]{background:rgba(201,138,62,.22);border-color:#c98a3e;color:#f1d3a6}
.hsp-wide{display:block;width:100%;margin-bottom:4px;text-align:left}
.hsp-nights{display:grid;grid-template-columns:repeat(${NIGHT_COUNT},1fr);gap:4px}
.hsp-fold{padding:2px 8px!important}
.hsp-status{margin:10px 0 0!important;padding-top:8px;border-top:1px solid rgba(228,220,204,.14);color:#e3b575;font-variant-numeric:tabular-nums}
`;

const HTML = `
<div class="hsp-head"><strong>Hold Still: desktop preview</strong><button class="hsp-fold" type="button" aria-expanded="true">Hide</button></div>
<div class="hsp-body">
  <p data-intro>Desktop preview: a virtual Quest 3 in a sample living room. Click Begin, then Enter the room. The autopilot plays for you; or let the monsters catch you.</p>
  <p class="hsp-note">Sound is on: turn your volume up. The Listener hears your real microphone: talking will get you caught.</p>
  <div class="hsp-controls" hidden>
  <span class="hsp-label">Hands</span>
  <button class="hsp-wide" type="button" data-hands="auto">Autopilot: plays perfectly</button>
  <button class="hsp-wide" type="button" data-hands="catch">Let them catch you</button>
  <span class="hsp-label">Jump to night</span>
  <div class="hsp-nights">${Array.from({ length: NIGHT_COUNT }, (_, i) => `<button type="button" data-night="${i + 1}">${i + 1}</button>`).join('')}</div>
  <span class="hsp-label">Camera</span>
  <button class="hsp-wide" type="button" data-camera></button>
  <p class="hsp-note" data-hint></p>
  </div>
  <p class="hsp-status" data-status></p>
</div>`;

/** Mount the panel and start the autopilot (only where IWER is active: a real headset just plays the game). */
export function mountPreviewPanel(director: Director): void {
  const device = (window as unknown as { IWER_DEVICE?: IwerDevice }).IWER_DEVICE;
  if (!device) return;
  const pilot = new Pilot(director, device);

  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);
  const root = document.createElement('aside');
  root.className = 'hsp';
  root.setAttribute('aria-label', 'Preview controls');
  root.innerHTML = HTML;
  document.body.appendChild(root);

  const $ = <T extends HTMLElement>(sel: string): T => root.querySelector(sel) as T;
  const fold = $<HTMLButtonElement>('.hsp-fold');
  const body = $('.hsp-body');
  const handButtons = root.querySelectorAll<HTMLButtonElement>('[data-hands]');
  const nightButtons = root.querySelectorAll<HTMLButtonElement>('[data-night]');
  const intro = $('[data-intro]');
  const controls = $('.hsp-controls');
  const camera = $<HTMLButtonElement>('[data-camera]');
  const hint = $('[data-hint]');
  const status = $('[data-status]');

  const render = (): void => {
    for (const b of handButtons) b.setAttribute('aria-pressed', String(b.dataset.hands === pilot.hands));
    camera.textContent = pilot.follow ? 'Camera: follow monsters' : 'Camera: free look';
    camera.setAttribute('aria-pressed', String(pilot.follow));
    const yours = pilot.hands === 'off';
    hint.textContent = pilot.follow
      ? `The view turns toward whatever is coming for you.${yours ? ' Your hands stay put: switch to free look to move them.' : ''}`
      : `IWER's controls: click the view, then the mouse looks and WASD moves; Esc lets go.${yours ? ' Drag the hand gizmos to move your hands.' : ''}`;
  };

  fold.addEventListener('click', () => {
    body.hidden = !body.hidden;
    fold.textContent = body.hidden ? 'Show' : 'Hide';
    fold.setAttribute('aria-expanded', String(!body.hidden));
  });
  for (const b of handButtons) {
    b.addEventListener('click', () => {
      const mode = b.dataset.hands as HandsMode;
      // Each toggles: the autopilot off leaves the hands to you; "catch" off goes back to the autopilot.
      pilot.hands = pilot.hands === mode ? (mode === 'auto' ? 'off' : 'auto') : mode;
      render();
    });
  }
  for (const b of nightButtons) b.addEventListener('click', () => director.flow.debugJumpToNight(Number(b.dataset.night)));
  camera.addEventListener('click', () => {
    pilot.follow = !pilot.follow;
    render();
  });
  render();

  let last = '';
  setInterval(() => {
    const flow = director.flow;
    const inRoom = !!device.activeSession;
    // The controls only matter in the room (and would cover the title page's buttons on a small window).
    if (controls.hidden === inRoom) {
      controls.hidden = !inRoom;
      intro.hidden = inRoom;
    }
    const canJump = inRoom && director.intro.done && flow.phase !== 'title' && flow.phase !== 'intro';
    for (const b of nightButtons) b.disabled = !canJump;
    let text: string;
    if (!inRoom) text = flow.phase === 'title' ? 'On the title page.' : 'Out of the room: Enter to resume.';
    else if (flow.phase === 'intro' || !director.intro.done) text = `Intro: ${director.intro.status.replace(/^place(\w+)/, (_, k: string) => `placing the ${k.toLowerCase()}`)}`;
    else {
      text = `Night ${flow.night}: ${PHASES[flow.phase]}`;
      if (flow.phase === 'caught' && flow.lastCaughtBy) text += ` by the ${NAMES[flow.lastCaughtBy]}`;
      const active = flow.phase === 'night' ? flow.runner?.activeAttacks() : undefined;
      if (active?.length) text = `Night ${flow.night}: ${active.map((a) => `${NAMES[a.id]} ${Math.round(a.meter * 100)}%`).join(', ')}`;
    }
    if (text !== last) status.textContent = last = text;
  }, 250);
}
