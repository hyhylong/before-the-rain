import test from 'node:test';
import assert from 'node:assert/strict';
import { SpeechPlayer } from '../src/speech.mjs';
import { TurnScope } from '../src/turn-scope.mjs';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function flush() {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

function browserHarness(t, options = {}) {
  const originals = new Map();
  const replace = (name, value) => {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  };
  let now = 0;
  let frameId = 0;
  let cancelCalls = 0;
  const frames = new Map();
  const audios = [];
  const spoken = [];
  const players = [];
  replace('performance', { now: () => now });
  replace('requestAnimationFrame', (callback) => { const id = ++frameId; frames.set(id, callback); return id; });
  replace('cancelAnimationFrame', (id) => frames.delete(id));
  replace('window', {
    speechSynthesis: {
      getVoices: () => options.voices ?? [{ lang: 'zh-CN', name: 'Test Chinese voice' }],
      speak: (utterance) => spoken.push(utterance),
      cancel: () => { cancelCalls += 1; },
    },
  });
  replace('SpeechSynthesisUtterance', class {
    constructor(text) { this.text = text; }
  });
  replace('Audio', class {
    constructor(url) {
      this.url = url;
      this.duration = 8;
      this.currentTime = 0;
      this.pauseCalls = 0;
      this.removedSource = false;
      audios.push(this);
    }
    play() { return options.play ? options.play(this) : Promise.resolve(); }
    pause() { this.pauseCalls += 1; }
    removeAttribute(name) { if (name === 'src') this.removedSource = true; }
    load() {}
  });
  if (options.fetch) replace('fetch', options.fetch);
  t.after(() => {
    players.forEach((player) => player.stop());
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  const step = (milliseconds) => {
    now += milliseconds;
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach((callback) => callback(now));
  };
  return { audios, spoken, frames, step, track: (player) => { players.push(player); return player; }, get cancelCalls() { return cancelCalls; } };
}

test('turn epochs invalidate queued network, media, and cleanup work after interruption', async () => {
  const scope = new TurnScope();
  const first = scope.next();
  let cleaned = 0;
  scope.addCleanup(() => { cleaned += 1; });
  const remove = scope.addCleanup(() => { cleaned += 100; });
  remove();
  const lateNetwork = deferred();
  const events = [];
  const response = lateNetwork.promise.then(() => {
    if (scope.current(first.id)) events.push('old-photo');
  });
  const second = scope.next();
  lateNetwork.resolve();
  await response;
  assert.equal(first.signal.aborted, true);
  assert.equal(second.signal.aborted, false);
  assert.equal(scope.current(first.id), false);
  assert.equal(scope.current(second.id), true);
  assert.equal(cleaned, 1);
  assert.deepEqual(events, []);
  scope.cancel();
  assert.equal(second.signal.aborted, true);
  assert.equal(cleaned, 1);
});

test('interrupt stops a recording immediately and suppresses progress and following media cues', async (t) => {
  const harness = browserHarness(t);
  const scope = new TurnScope();
  const player = harness.track(new SpeechPlayer());
  player.manifest = { '第一句话': '/audio/first.mp3' };
  const first = scope.next();
  const progress = [];
  const events = [];
  const playback = (async () => {
    await player.play('第一句话', { signal: first.signal, onProgress: (value) => progress.push(value) });
    if (scope.current(first.id)) events.push('unplayed-photo-event');
  })();
  await flush();
  assert.equal(harness.audios.length, 1);
  harness.audios[0].currentTime = 2;
  harness.step(2000);
  assert.deepEqual(progress, [0.25]);
  scope.next();
  await playback;
  const previousProgress = [...progress];
  harness.step(10000);
  assert.ok(harness.audios[0].pauseCalls >= 1);
  assert.equal(harness.audios[0].removedSource, true);
  assert.equal(harness.frames.size, 0);
  assert.deepEqual(progress, previousProgress);
  assert.deepEqual(events, []);
});

test('simultaneous media error and play rejection fall back to browser speech only once', async (t) => {
  const gate = deferred();
  const harness = browserHarness(t, { play: () => gate.promise });
  const controller = new AbortController();
  const player = harness.track(new SpeechPlayer());
  player.manifest = { '同一句话': '/audio/unavailable.mp3' };
  let fallbackCalls = 0;
  const playback = player.play('同一句话', { signal: controller.signal, onFallback: () => { fallbackCalls += 1; } });
  harness.audios[0].onerror();
  gate.reject(new Error('Media load failed'));
  await flush();
  assert.equal(harness.spoken.length, 1);
  assert.equal(harness.spoken[0].text, '同一句话');
  assert.equal(fallbackCalls, 0);
  assert.equal(harness.frames.size, 1);
  controller.abort();
  await playback;
  assert.equal(harness.frames.size, 0);
});

test('a delayed TTS response cannot begin audio or subtitles after its turn is cancelled', async (t) => {
  const response = deferred();
  const harness = browserHarness(t, { fetch: () => response.promise });
  const controller = new AbortController();
  const player = harness.track(new SpeechPlayer());
  let progressCalls = 0;
  const playback = player.play('服务端很晚才返回的话', {
    signal: controller.signal, serverTts: true,
    onProgress: () => { progressCalls += 1; },
  });
  controller.abort();
  await playback;
  response.resolve({ ok: true, blob: async () => new Blob(['late audio'], { type: 'audio/mpeg' }) });
  await flush();
  assert.equal(harness.audios.length, 0);
  assert.equal(harness.spoken.length, 0);
  assert.equal(harness.frames.size, 0);
  assert.equal(progressCalls, 0);
});

test('missing browser voices gives one visible fallback and completes timed subtitles', async (t) => {
  const harness = browserHarness(t, { voices: [] });
  const controller = new AbortController();
  const player = harness.track(new SpeechPlayer());
  let fallbacks = 0;
  const progress = [];
  const levels = [];
  const playback = player.play('继续显示字幕。', {
    signal: controller.signal,
    onFallback: () => { fallbacks += 1; },
    onProgress: (value) => progress.push(value),
    onLevel: (value) => levels.push(value),
  });
  assert.equal(fallbacks, 1);
  harness.step(1100);
  assert.ok(progress[0] > 0 && progress[0] < 1);
  harness.step(1100);
  assert.equal(await playback, 'silent');
  assert.equal(progress.at(-1), 1);
  assert.equal(levels.at(-1), 0);
  assert.equal(harness.frames.size, 0);
  assert.equal(harness.spoken.length, 0);
});

test('a browser utterance error switches to a single subtitle animation and remains cancellable', async (t) => {
  const harness = browserHarness(t);
  const controller = new AbortController();
  const player = harness.track(new SpeechPlayer());
  let fallbacks = 0;
  const playback = player.play('浏览器语音失败以后仍然可以继续。', { signal: controller.signal, onFallback: () => { fallbacks += 1; } });
  assert.equal(harness.frames.size, 1);
  harness.spoken[0].onerror();
  harness.spoken[0].onerror();
  assert.equal(fallbacks, 1);
  assert.equal(harness.frames.size, 1);
  controller.abort();
  await playback;
  assert.equal(harness.frames.size, 0);
});
