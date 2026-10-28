import test from 'node:test';
import assert from 'node:assert/strict';
import { createUtteranceGate, isBackchannel } from '../src/voice/utterance.mjs';
import { createVisemeTimeline, rmsLevel, visemeAt } from '../src/voice/visemes.mjs';
import { createAutomaticVoice } from '../src/voice/automatic.mjs';
import { SpeechPlayer } from '../src/speech.mjs';

function replaceGlobal(t, name, value) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  t.after(() => descriptor ? Object.defineProperty(globalThis, name, descriptor) : delete globalThis[name]);
}
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

test('short acknowledgements preserve playback, substantive speech interrupts once', () => {
  assert.equal(isBackchannel('嗯，对。', 700), true);
  assert.equal(isBackchannel('yeah', 900), true);
  assert.equal(isBackchannel('嗯，我想问另外一个问题', 900), false);
  assert.equal(isBackchannel('嗯', 2100), false);
  const calls = [];
  const gate = createUtteranceGate({ onCandidate: () => calls.push('duck'), onInterrupt: () => calls.push('interrupt'), onBackchannel: () => calls.push('ack') });
  gate.begin(0, true); gate.transcript('嗯，对。', 700);
  assert.deepEqual(gate.end(800), { text: '', backchannel: true, interrupted: false, durationMs: 800 });
  assert.deepEqual(calls, ['duck', 'ack']);
  gate.begin(1000, true); gate.transcript('等一下，我想看照片', 1800); gate.transcript('等一下，我想看照片', 1900);
  assert.equal(gate.end(2000).interrupted, true);
  assert.deepEqual(calls, ['duck', 'ack', 'duck', 'interrupt']);
});

test('confirmed long speech can interrupt before transcription, cancelled segments cannot', () => {
  let interruptions = 0;
  const gate = createUtteranceGate({ onInterrupt: () => { interruptions += 1; } });
  gate.begin(0, true); gate.tick(1950); gate.tick(2200);
  assert.equal(interruptions, 1);
  gate.cancel(); gate.transcript('迟到的识别', 3000); gate.tick(5000);
  assert.equal(interruptions, 1);
});

test('pinyin vowel shapes follow measured duration and close for silence', () => {
  const timeline = createVisemeTimeline('啊一呜，', 4000);
  assert.deepEqual(timeline.map((cue) => cue.shape), ['aa', 'ee', 'oo', 'closed']);
  assert.equal(timeline.at(-1).endMs, 4000);
  assert.ok(visemeAt(timeline, 500, 0.7).aa > 0.5);
  assert.ok(visemeAt(timeline, 1500, 0.7).ee > 0.5);
  assert.ok(visemeAt(timeline, 2700, 0.7).oo > 0.5);
  assert.equal(visemeAt(timeline, 500, 0).closed, 1);
  assert.equal(visemeAt(timeline, 3900, 0.9).closed, 1);
  assert.equal(rmsLevel(new Float32Array([0, 0, 0])), 0);
  assert.ok(Math.abs(rmsLevel(new Float32Array([0.1, -0.1])) - 0.5) < 0.00001);
});

test('speech analyser reports actual waveform changes and disconnects on cancellation', async (t) => {
  let player;
  t.after(() => player?.stop());
  let sample = 0;
  let disconnected = 0;
  let frame;
  let audio;
  const levels = [];
  const shapes = [];
  replaceGlobal(t, 'requestAnimationFrame', (callback) => { frame = callback; return 1; });
  replaceGlobal(t, 'cancelAnimationFrame', () => { frame = null; });
  replaceGlobal(t, 'window', {
    AudioContext: class {
      state = 'running'; destination = {};
      async resume() {}
      createMediaElementSource() { return { connect() {}, disconnect() { disconnected += 1; } }; }
      createAnalyser() { return { fftSize: 512, connect() {}, disconnect() { disconnected += 1; }, getFloatTimeDomainData(array) { array.fill(sample); } }; }
    },
    speechSynthesis: { cancel() {} },
  });
  replaceGlobal(t, 'Audio', class {
    constructor() { audio = this; this.currentTime = 0; this.duration = 4; this.paused = false; }
    play() { return Promise.resolve(); } pause() { this.paused = true; }
    removeAttribute() {} load() {}
  });
  player = new SpeechPlayer(); player.manifest = { '啊一呜': '/audio/real.mp3' };
  const controller = new AbortController();
  const playback = player.play('啊一呜', { signal: controller.signal, onLevel: (level) => levels.push(level), onViseme: (shape) => shapes.push(shape) });
  await flush();
  audio.ondurationchange();
  audio.currentTime = 0.6; frame();
  assert.equal(levels.at(-1), 0);
  sample = 0.12; frame();
  assert.ok(levels.at(-1) > 0.59);
  assert.ok(shapes.at(-1).aa > 0.4);
  player.setDucked(true); assert.ok(Math.abs(audio.volume - 0.1275) < 0.00001);
  player.muted = true; frame();
  assert.equal(audio.muted, true); assert.equal(audio.volume, 0); assert.equal(audio.paused, false); assert.equal(levels.at(-1), 0);
  player.volume = 0.4; player.setDucked(false);
  assert.equal(audio.volume, 0);
  player.setDucked(true); player.muted = false;
  assert.equal(audio.muted, false); assert.equal(audio.volume, 0.06);
  controller.abort(); await playback;
  assert.equal(audio.paused, true); assert.equal(levels.at(-1), 0); assert.equal(disconnected, 2);
});

test('muting active browser speech stops synthesis and continues captions without a fallback warning', async (t) => {
  let currentTime = 0;
  let frame;
  let active;
  let cancellations = 0;
  let warnings = 0;
  const progress = [];
  replaceGlobal(t, 'performance', { now: () => currentTime });
  replaceGlobal(t, 'requestAnimationFrame', (callback) => { frame = callback; return 1; });
  replaceGlobal(t, 'cancelAnimationFrame', () => {});
  replaceGlobal(t, 'SpeechSynthesisUtterance', class { constructor(text) { this.text = text; } });
  replaceGlobal(t, 'window', { speechSynthesis: {
    getVoices: () => [{ lang: 'zh-CN' }],
    speak(utterance) { active = utterance; utterance.onstart(); },
    cancel() { cancellations += 1; active?.onend?.(); },
  } });
  const player = new SpeechPlayer();
  const controller = new AbortController();
  const playback = player.play('窗外的雨停了', { signal: controller.signal, onProgress: (value) => progress.push(value), onFallback: () => { warnings += 1; } });
  currentTime = 1000; frame();
  const beforeMute = progress.at(-1);
  const beforeCancel = cancellations;
  player.muted = true;
  assert.equal(cancellations, beforeCancel + 1);
  assert.equal(active.volume, 0); assert.equal(player.currentUtterance, null);
  currentTime = 1500; frame();
  assert.ok(progress.at(-1) > beforeMute);
  assert.equal(warnings, 0);
  controller.abort();
  assert.equal(await playback, 'silent');
});

test('streaming TTS appends audio bytes before response completion and abort cancels transport', async (t) => {
  let bodyController;
  let cancelled = false;
  let fetchSignal;
  const chunks = [];
  const timings = [];
  let mediaSource;
  const body = new ReadableStream({ start(controller) { bodyController = controller; }, cancel() { cancelled = true; } });
  class SourceBuffer extends EventTarget {
    updating = false;
    appendBuffer(chunk) {
      chunks.push([...chunk]); this.updating = true;
      queueMicrotask(() => { this.updating = false; this.dispatchEvent(new Event('updateend')); });
    }
    abort() {}
  }
  class MediaSource extends EventTarget {
    static isTypeSupported() { return true; }
    constructor() { super(); mediaSource = this; this.readyState = 'closed'; }
    addSourceBuffer() { return new SourceBuffer(); }
    endOfStream() { this.readyState = 'ended'; }
  }
  replaceGlobal(t, 'window', { MediaSource, speechSynthesis: { cancel() {} } });
  replaceGlobal(t, 'fetch', async (_url, options) => { fetchSignal = options.signal; return { ok: true, body }; });
  replaceGlobal(t, 'URL', { createObjectURL: () => 'blob:stream', revokeObjectURL() {} });
  replaceGlobal(t, 'requestAnimationFrame', () => 1); replaceGlobal(t, 'cancelAnimationFrame', () => {});
  replaceGlobal(t, 'Audio', class {
    currentTime = 0; duration = Infinity;
    async play() { mediaSource.readyState = 'open'; mediaSource.dispatchEvent(new Event('sourceopen')); }
    pause() {} removeAttribute() {} load() {}
  });
  const player = new SpeechPlayer();
  const controller = new AbortController();
  const playback = player.play('一段真正分块到达的语音', { serverTts: true, signal: controller.signal, onTiming: (event) => timings.push(event) });
  await flush();
  bodyController.enqueue(new Uint8Array([1, 2, 3])); await flush();
  assert.deepEqual(chunks, [[1, 2, 3]]);
  assert.ok(timings.some((event) => event.phase === 'first-packet'));
  assert.equal(cancelled, false);
  controller.abort(); await playback; await flush();
  assert.equal(fetchSignal.aborted, true); assert.equal(cancelled, true);
  assert.equal(await playback, 'stream');
});

test('automatic voice uses echo cancellation and releases late microphone startup', async (t) => {
  let options;
  let microphoneRequests = 0;
  let stopped = 0;
  const callbacks = [];
  const recognizes = [];
  let currentTime = 0;
  replaceGlobal(t, 'performance', { now: () => currentTime });
  replaceGlobal(t, 'navigator', { mediaDevices: { async getUserMedia(constraints) { microphoneRequests += 1; assert.equal(constraints.audio.echoCancellation, true); return { active: true, getTracks: () => [{ stop() { stopped += 1; } }] }; } } });
  replaceGlobal(t, 'window', { isSecureContext: true, SpeechRecognition: class {
    constructor() { recognizes.push(this); } start() {} abort() {}
  } });
  const instance = { async start() { await options.getStream(); }, async destroy() {} };
  const voice = createAutomaticVoice({
    loadVad: async () => ({ MicVAD: { async new(value) { options = value; return instance; } } }),
    getPlaybackState: () => ({ speaking: true, text: '雨这么大，你也在等人吗？' }),
    finalGraceMs: 0, serverSttAvailable: false,
    onSpeechStart: (event) => callbacks.push(event.phase), onTranscript: (event) => callbacks.push(event.text),
    onBackchannel: () => callbacks.push('ack'),
  });
  await voice.start(); assert.equal(microphoneRequests, 1);
  options.onSpeechStart(); currentTime = 400;
  const short = [[{ transcript: '嗯，对' }]]; short[0].isFinal = true;
  recognizes[0].onresult({ results: short });
  options.onFrameProcessed({ isSpeech: 0.9 }); options.onSpeechEnd(new Float32Array(1600));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(callbacks, ['candidate', 'ack']);
  currentTime = 1000; options.onSpeechStart(); currentTime = 1800;
  const content = [...short, [{ transcript: '我想看看灯塔照片' }]]; content[1].isFinal = true;
  recognizes[0].onresult({ results: content }); options.onFrameProcessed({ isSpeech: 0.9 }); options.onSpeechEnd(new Float32Array(1600));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(callbacks, ['candidate', 'ack', 'candidate', 'interrupt', '我想看看灯塔照片']);
  currentTime = 3000; options.onSpeechStart(); currentTime = 5100;
  const echo = [...content, [{ transcript: '雨这么大，你也在等人吗' }]]; echo[2].isFinal = true;
  recognizes[0].onresult({ results: echo }); options.onFrameProcessed({ isSpeech: 0.9 }); options.onSpeechEnd(new Float32Array(1600));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(callbacks, ['candidate', 'ack', 'candidate', 'interrupt', '我想看看灯塔照片', 'candidate', 'ack']);
  await voice.stop(); assert.equal(voice.active, false); assert.ok(stopped >= 1);
  const previous = [...callbacks]; options.onSpeechStart(); recognizes[0].onresult?.({ results: content });
  assert.deepEqual(callbacks, previous);
});

test('disabling automatic voice during microphone authorization cannot restore the old stream', async (t) => {
  let releaseMicrophone;
  let requested;
  let options;
  let stops = 0;
  const microphoneRequested = new Promise((resolve) => { requested = resolve; });
  const stream = new Promise((resolve) => { releaseMicrophone = resolve; });
  replaceGlobal(t, 'navigator', { mediaDevices: { getUserMedia() { requested(); return stream; } } });
  replaceGlobal(t, 'window', { isSecureContext: true });
  const voice = createAutomaticVoice({
    loadVad: async () => ({ MicVAD: { async new(value) { options = value; return { async start() { await options.getStream(); }, async destroy() {} }; } } }),
  });
  const starting = voice.start();
  await microphoneRequested;
  await voice.stop();
  releaseMicrophone({ active: true, getTracks: () => [{ stop() { stops += 1; } }] });
  await starting;
  assert.equal(voice.active, false);
  assert.equal(stops, 1);
});
