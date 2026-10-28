import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';

const base = process.env.AUDIO_TEST_URL || 'http://localhost:4185';
const fixture = '/tmp/mira-vad-fixture.wav';
execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', 'public/audio/69c2a8231cb8.mp3', '-af', 'apad=whole_dur=10', '-ar', '48000', '-ac', '1', fixture], { stdio: 'ignore' });
const browser = await chromium.launch({
  channel: 'chromium', headless: true,
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required', '--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${fixture}`],
});
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (error) => errors.push(error.message));
await page.route('**/audio-fixture', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Audio fixture</title>' }));
await page.route('**/api/stt', (route) => route.fulfill({ json: { text: '我想看看你的照片' } }));
const mp3 = await readFile('public/audio/69c2a8231cb8.mp3');
await page.route('**/api/tts/stream', (route) => route.fulfill({ contentType: 'audio/mpeg', body: mp3 }));
await page.addInitScript(() => {
  window.SpeechRecognition = undefined; window.webkitSpeechRecognition = undefined;
  window.__audioTracks = [];
  const original = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    const stream = await original(constraints); window.__audioTracks.push(...stream.getTracks()); return stream;
  };
});
try {
  await page.goto(`${base}/audio-fixture`);
  await page.evaluate(async () => {
    const { createAutomaticVoice } = await import('/src/voice/automatic.mjs');
    window.__vadEvents = [];
    window.__voice = createAutomaticVoice({
      getPlaybackState: () => true, serverSttAvailable: true, finalGraceMs: 0,
      onSpeechStart: (event) => window.__vadEvents.push(event),
      onSpeechEnd: (event) => window.__vadEvents.push({ phase: 'end', ...event }),
      onTranscript: (event) => window.__vadEvents.push({ phase: 'transcript', ...event }),
      onError: (error) => window.__vadEvents.push({ phase: 'error', message: error.message }),
    });
    await window.__voice.start();
  });
  await page.waitForFunction(() => window.__vadEvents.some((event) => event.phase === 'transcript'), undefined, { timeout: 25000 });
  const vadResult = await page.evaluate(async () => { await window.__voice.stop(); return { events: window.__vadEvents, tracksEnded: window.__audioTracks.every((track) => track.readyState === 'ended') }; });
  assert.ok(vadResult.events.some((event) => event.phase === 'interrupt'));
  assert.ok(vadResult.events.some((event) => event.phase === 'transcript' && event.text === '我想看看你的照片'));
  assert.equal(vadResult.tracksEnded, true);
  console.log(JSON.stringify({ realSileroV5Inference: vadResult }));
  const audioResult = await page.evaluate(async () => {
    const { SpeechPlayer, INTRO } = await import('/src/speech.mjs');
    const player = new SpeechPlayer(); await player.unlock();
    const controller = new AbortController();
    const levels = []; const timings = []; const shapes = [];
    const playback = player.play(INTRO, { serverTts: true, signal: controller.signal, onLevel: (level) => levels.push(level), onViseme: (shape) => shapes.push(shape), onTiming: (event) => timings.push(event) });
    await new Promise((resolve) => setTimeout(resolve, 2500));
    controller.abort(); const source = await playback;
    return { source, peak: Math.max(...levels), movingMouth: shapes.some((shape) => shape.aa > 0.1 || shape.ee > 0.1 || shape.oo > 0.1), timings };
  });
  assert.equal(audioResult.source, 'stream'); assert.ok(audioResult.peak > 0.05); assert.equal(audioResult.movingMouth, true);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ realMp3MsePlaybackAndAnalysis: audioResult }));
} finally { await browser.close(); }
