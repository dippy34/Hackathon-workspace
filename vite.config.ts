/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 */

import { iwsdkDev } from '@iwsdk/vite-plugin-dev';
import { defineConfig, type Plugin } from 'vite';

/**
 * `npm run build:preview` (HOLDSTILL_PREVIEW=1): the desktop preview build with IWER baked in, into
 * site/preview/. Run it after `build:site` (which empties site/); `npm run build:all` does both.
 */
const PREVIEW = process.env.HOLDSTILL_PREVIEW === '1';

/** Emulator for the preview build: a virtual Quest 3 in IWER's sample living room, on any host. */
const PREVIEW_EMULATOR = { device: 'metaQuest3', environment: 'living_room', activation: 'always', injectOnBuild: true };

/**
 * iwsdk.config.json is the plugin's authority (iwsdkDev({ emulator }) throws when it exists), so
 * the preview build overlays PREVIEW_EMULATOR onto the manifest's dev.emulator while the plugin's
 * config hook parses it (synchronously, before its first await). The file itself never changes.
 */
function iwsdk(): Plugin {
  const plugin = iwsdkDev();
  const config = plugin.config;
  if (!PREVIEW) return plugin;
  if (typeof config !== 'function') throw new Error('iwsdkDev() has no config hook to overlay the preview emulator onto');
  plugin.config = function (this: unknown, ...args: Parameters<typeof config>) {
    const parse = JSON.parse;
    JSON.parse = (text, reviver) => {
      const value = parse(text, reviver);
      if (value?.version === 'iwsdk.project.v1') {
        value.dev = { ...value.dev, emulator: { ...value.dev?.emulator, ...PREVIEW_EMULATOR } };
      }
      return value;
    };
    try {
      return config.apply(this as never, args);
    } finally {
      JSON.parse = parse;
    }
  } as typeof config;
  return plugin;
}

export default defineConfig({
  plugins: [iwsdk()],
  define: { __HOLDSTILL_PREVIEW__: JSON.stringify(PREVIEW) },
  server: { host: '0.0.0.0', port: 8081, open: false },
  build: {
    outDir: 'dist',
    sourcemap: process.env.NODE_ENV !== 'production',
    target: 'esnext',
    rollupOptions: { input: './index.html' },
  },
  esbuild: { target: 'esnext' },
  // @drawcall/uikitml otherwise pulls a second three/@pmndrs/uikit graph
  // (three@0.185 vs app super-three@0.181). Duplicate Component classes break
  // instanceof checks → "Only pmndrs/uikit components can be added as children".
  resolve: {
    dedupe: [
      'three',
      '@pmndrs/uikit',
      '@pmndrs/uikit-horizon',
      '@pmndrs/uikit-lucide',
    ],
  },
  optimizeDeps: {
    exclude: ['@babylonjs/havok'],
    include: [
      'three',
      '@pmndrs/uikit',
      '@pmndrs/uikit-horizon',
      '@pmndrs/uikit-lucide',
      '@drawcall/uikitml',
    ],
    esbuildOptions: { target: 'esnext' },
  },
  publicDir: 'public',
  base: './',
});
