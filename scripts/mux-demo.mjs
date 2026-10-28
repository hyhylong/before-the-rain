import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function muxDemo(recording) {
  const rate = 24000;
  const samples = new Float32Array(Math.ceil(recording.duration * rate));
  for (const track of recording.tracks) {
    const asset = track.asset || `audio/${track.file}`;
    if (!/^(audio|video)\/[a-zA-Z0-9_-]+\.(mp3|webm|mp4)$/.test(asset)) throw new Error('Unexpected recording asset');
    const pcm = execFileSync('ffmpeg', ['-v', 'error', '-ss', String(track.offset || 0), '-i', path.join('public', asset), '-f', 's16le', '-acodec', 'pcm_s16le', '-ar', String(rate), '-ac', '1', 'pipe:1'], { maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
    const start = Math.max(0, Math.round(track.delayMs / 1000 * rate));
    const count = Math.min(Math.floor(pcm.length / 2), Math.round(track.elapsed * rate), samples.length - start);
    for (let i = 0; i < count; i++) samples[start + i] += pcm.readInt16LE(i * 2) * (track.gain ?? 1);
  }
  const wav = Buffer.alloc(44 + samples.length * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
  wav.write('data', 36); wav.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) wav.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i]))), 44 + i * 2);
  await writeFile('artifacts/raw/voice.wav', wav);
  const speed = recording.duration > 290 ? recording.duration / 275 : 1;
  const duration = recording.duration / speed;
  execFileSync('ffmpeg', [
    '-y', '-v', 'error', '-i', recording.rawVideo, '-i', 'artifacts/raw/voice.wav',
    '-vf', `setpts=PTS/${speed}`, '-af', `atempo=${speed}`,
    '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-threads', '4',
    '-c:a', 'aac', '-b:a', '128k', '-t', String(duration), '-movflags', '+faststart', 'artifacts/demo.mp4',
  ], { stdio: ['ignore', 'ignore', 'pipe'], maxBuffer: 2 * 1024 * 1024 });
  await writeFile('artifacts/demo-timeline.json', JSON.stringify({
    duration,
    rawDuration: recording.duration,
    playbackSpeed: speed,
    audioSegments: recording.tracks.length,
    timeline: recording.timeline.map((entry) => ({ ...entry, seconds: Math.round(entry.seconds / speed) })),
    method: 'Real browser recording; actual local audio and video soundtrack playback timestamps, offsets, volume and interruption positions. Uniform speed adjustment with pitch preserved when needed to stay within 3–5 minutes. No microphone recording.',
  }, null, 2));
  console.log(`Saved artifacts/demo.mp4 (${duration.toFixed(1)}s; ${recording.tracks.length} audio segments; ${speed.toFixed(3)}x).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await muxDemo(JSON.parse(await readFile(process.argv[2] || 'artifacts/raw/recording.json', 'utf8')));
}
