import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const root = fileURLToPath(new URL('../', import.meta.url));
const { ALL_MOCK_LINES } = await import('../server/story.mjs');
const intro = '雨这么大，你也在等人吗？进来吧，咖啡还热着。';
const texts = [...new Set([intro, ...ALL_MOCK_LINES])];
const directory = path.join(root, 'public/audio');
const python = process.env.MIRA_AUDIO_PYTHON || 'python';
const voice = process.env.MIRA_AUDIO_VOICE || 'zh-CN-XiaoxiaoNeural';
const manifest = {};
await mkdir(directory, { recursive: true });

async function generate(text) {
  const name = `${createHash('sha256').update(text).digest('hex').slice(0, 12)}.mp3`;
  const filename = path.join(directory, name);
  manifest[text] = `/audio/${name}`;
  try {
    if ((await stat(filename)).size > 1000) return;
  } catch {}
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await exec(python, [
        '-m', 'edge_tts', '--voice', voice, '--rate=-8%',
        '--text', text, '--write-media', filename,
      ], { timeout: 60000 });
      console.log(`Created ${name}`);
      return;
    } catch (error) {
      if (attempt === 2) throw error;
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
  }
}

// Keep requests bounded so asset regeneration does not overwhelm the service.
for (let index = 0; index < texts.length; index += 3) {
  await Promise.all(texts.slice(index, index + 3).map(generate));
}
await writeFile(path.join(directory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Saved ${texts.length} local Mandarin voice clips.`);
