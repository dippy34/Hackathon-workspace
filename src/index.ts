import { World } from '@iwsdk/core';
import projectOptions from 'virtual:iwsdk-project';
import { AudioEngine } from './audio/engine.js';
import { CONFIG } from './config.js';
import { Director, DirectorSystem, directorRef } from './game/director.js';
import { Mic } from './senses/mic.js';
import { mountTitle } from './ui/title.js';

/** ?debug=1 / ?debug=0 overrides the default (overlay on during development milestones). */
function debugEnabled(): boolean {
  const q = new URLSearchParams(location.search).get('debug');
  if (q === '1' || q === 'true') return true;
  if (q === '0' || q === 'false') return false;
  return CONFIG.debug.overlayDefault;
}

async function main(): Promise<void> {
  const debug = debugEnabled();
  // Our own AudioContext (IWSDK suspends its shared one when a session ends);
  // the mic analyser hangs off the same context but never reaches the speakers.
  const audio = new AudioEngine();
  const mic = new Mic(audio.ctx);

  const world = await World.create(document.getElementById('scene-container') as HTMLDivElement, {
    ...projectOptions,
    // The title page asks for the mic first, then launches XR from its own button.
    xr: projectOptions.xr === false ? false : { ...projectOptions.xr, offer: 'none' as const },
  });

  const director = new Director(world, audio, mic, debug);
  directorRef.current = director;
  world.registerSystem(DirectorSystem, { priority: 1 });

  const title = mountTitle(document.getElementById('title-root') as HTMLElement, {
    onBegin: async () => {
      // Both calls start inside the click so they keep its user activation.
      const resumed = audio.resume();
      const status = mic.request();
      await resumed;
      return status;
    },
    onEnter: () => {
      world.launchXR();
    },
  });

  const supported = (await navigator.xr?.isSessionSupported('immersive-ar').catch(() => false)) ?? false;
  title.setXRSupport(supported, supported ? undefined : 'immersive-ar is not available in this browser');

  world.renderer.xr.addEventListener('sessionstart', () => title.hide());
  director.onSessionEnded = () => {
    title.setResume(director.resumeText);
    title.show();
  };

  if (debug) {
    // Test/debug hook (emulator scripts): inspect state and jump between nights.
    (window as unknown as { __holdStill: unknown }).__holdStill = {
      director,
      flow: director.flow,
      enterXR: () => world.launchXR(),
      jumpToNight: (n: number) => director.flow.debugJumpToNight(n),
      state: () => ({
        phase: director.flow.phase,
        night: director.flow.night,
        restarts: director.flow.restarts,
        lastCaughtBy: director.flow.lastCaughtBy,
        intro: director.intro.status,
        mic: mic.status,
        windows: director.room.windows.length,
        doors: director.room.doors.length,
        report: director.room.report,
        active: director.flow.runner?.activeAttacks().map((a) => ({ id: a.id, meter: a.meter, countering: a.countering })),
      }),
    };
  }
}

void main();
