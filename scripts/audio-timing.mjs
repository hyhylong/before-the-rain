import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { createVisemeTimeline } from '../src/voice/visemes.mjs';

const manifest = JSON.parse(await readFile(new URL('../public/audio/manifest.json', import.meta.url), 'utf8'));
const timing = {};
for (const [text, url] of Object.entries(manifest)) {
  const filename = new URL(`../public${url}`, import.meta.url);
  const durationMs = Math.round(Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', filename.pathname], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()) * 1000);
  timing[text] = { durationMs, source: 'estimated-pinyin', cues: createVisemeTimeline(text, durationMs) };
}
await writeFile(new URL('../public/audio/timing.json', import.meta.url), `${JSON.stringify(timing, null, 2)}\n`);
console.log(`Aligned ${Object.keys(timing).length} recordings by measured duration and estimated pinyin visemes.`);
