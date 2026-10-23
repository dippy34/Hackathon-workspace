// Guards the two builds (run after `npm run build:all`):
// - the desktop preview (site/preview/) must ship Meta's IWER emulator, active on any host;
// - the Quest build (site/) must not contain the emulator or any preview code.
// The preview overlays its emulator settings onto the IWSDK plugin's config at build time, so a
// plugin upgrade could silently drop them; this makes that fail loudly instead.
import fs from 'node:fs';
import path from 'node:path';

const read = (dir) =>
  fs.readdirSync(dir).filter((f) => f.endsWith('.js')).map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
const quest = read('site/assets');
const preview = read('site/preview/assets');
const fail = [];
if (!preview.includes('IWER_DEVICE')) fail.push('preview build is missing the IWER emulator');
if (!preview.includes('activation:"always"')) fail.push('preview emulator is not set to activate on every host');
if (quest.includes('IWER_DEVICE')) fail.push('Quest build contains the IWER emulator');
if (quest.includes('Hold Still: desktop preview')) fail.push('Quest build contains preview code');
if (fail.length) {
  console.error(`check-builds failed:\n- ${fail.join('\n- ')}`);
  process.exit(1);
}
console.log('check-builds: Quest build clean, desktop preview has the emulator');
