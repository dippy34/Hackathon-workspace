// Writes a quiet "room tone" WAV used as the fake microphone in emulator tests.
// Usage: node e2e/make-wav.mjs <out.wav> [rms=0.003] [seconds=30]
import fs from 'node:fs';
const [out, rmsArg, secArg] = process.argv.slice(2);
const rms = Number(rmsArg ?? 0.003), sec = Number(secArg ?? 30), rate = 48000, n = rate * sec;
const buf = Buffer.alloc(44 + n * 2);
buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22); buf.writeUInt32LE(rate, 24);
buf.writeUInt32LE(rate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
let seed = 1;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
const amp = rms * Math.sqrt(3); // uniform noise: rms = amp / sqrt(3)
for (let i = 0; i < n; i++) buf.writeInt16LE(Math.round(rnd() * amp * 32767), 44 + i * 2);
fs.writeFileSync(out, buf);
