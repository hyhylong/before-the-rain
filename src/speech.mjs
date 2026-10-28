import { createVisemeTimeline, rmsLevel, visemeAt } from './voice/visemes.mjs';

export const INTRO = '雨这么大，你也在等人吗？进来吧，咖啡还热着。';

export class SpeechPlayer {
  manifest = {};
  timing = {};
  stopCurrent = null;
  context = null;
  currentAudio = null;
  currentUtterance = null;
  muteCurrent = null;
  ducked = false;
  _muted = false;
  _volume = 0.85;

  get muted() { return this._muted; }
  set muted(value) {
    this._muted = Boolean(value);
    this.applyVolume();
    if (this._muted) this.muteCurrent?.();
  }

  get volume() { return this._volume; }
  set volume(value) {
    this._volume = Math.max(0, Math.min(1, value));
    this.applyVolume();
  }

  get outputVolume() { return this.muted ? 0 : this.volume * (this.ducked ? 0.15 : 1); }

  applyVolume() {
    if (this.currentAudio) { this.currentAudio.muted = this.muted; this.currentAudio.volume = this.outputVolume; }
    if (this.currentUtterance) this.currentUtterance.volume = this.outputVolume;
  }

  async load() {
    await Promise.all(['/audio/manifest.json', '/audio/timing.json'].map(async (url) => {
      try {
        const response = await fetch(url);
        if (response.ok) {
          if (url.includes('manifest')) this.manifest = await response.json();
          else this.timing = await response.json();
        }
      } catch { /* Optional alignment and recordings may fall back to browser speech. */ }
    }));
  }

  async unlock() {
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) return null;
    try {
      this.context ||= new Context();
      await this.context.resume();
      return this.context;
    } catch { return null; }
  }

  prefetch(texts = []) {
    for (const text of texts.slice(0, 4)) {
      const url = this.manifest[text];
      if (url) fetch(url, { cache: 'force-cache' }).catch(() => {});
    }
  }

  setDucked(value) {
    this.ducked = Boolean(value);
    this.applyVolume();
  }

  stop() {
    this.stopCurrent?.();
    this.stopCurrent = null;
    window.speechSynthesis?.cancel();
  }

  play(text, { signal, onProgress, onLevel, onViseme, onTiming, serverTts = false, onFallback, timing }) {
    this.stop();
    return new Promise((resolve) => {
      let audio;
      let utterance;
      let objectUrl;
      let frame;
      let watchdog;
      let finished = false;
      let start = performance.now();
      const requestedAt = start;
      let duration = timing?.durationMs || this.timing[text]?.durationMs || Math.max(2200, text.length * 155);
      let timeline = timing?.cues || this.timing[text]?.cues || createVisemeTimeline(text, duration);
      const visemeSource = timing?.source || this.timing[text]?.source || 'estimated-pinyin';
      let outcome = 'silent';
      let usingBrowser = false;
      let silentStarted = false;
      let analyser;
      let analyserSamples;
      let mediaNode;
      let reader;
      let mediaSource;
      let sourceBuffer;
      let boundaryIndex = null;
      let audioStarted = false;
      let firstPacket = false;
      let muteBrowser;
      const transport = new AbortController();
      const cleanupMedia = () => {
        transport.abort();
        reader?.cancel().catch(() => {});
        try { sourceBuffer?.abort(); } catch { /* It may already be detached. */ }
        try { mediaNode?.disconnect(); analyser?.disconnect(); } catch { /* Already disconnected. */ }
        analyser = null; mediaNode = null;
        if (audio) { audio.pause(); audio.removeAttribute('src'); audio.load(); }
        if (this.currentAudio === audio) this.currentAudio = null;
        audio = null;
        if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = null; }
      };
      const finish = () => {
        if (finished) return;
        finished = true;
        cancelAnimationFrame(frame);
        clearTimeout(watchdog);
        signal?.removeEventListener('abort', finish);
        cleanupMedia();
        if (utterance) window.speechSynthesis?.cancel();
        if (this.currentUtterance === utterance) this.currentUtterance = null;
        if (this.muteCurrent === muteBrowser) this.muteCurrent = null;
        onLevel?.(0);
        onViseme?.({ aa: 0, ee: 0, oo: 0, closed: 1, source: visemeSource });
        if (this.stopCurrent === finish) this.stopCurrent = null;
        resolve(outcome);
      };
      this.stopCurrent = finish;
      signal?.addEventListener('abort', finish, { once: true });
      if (signal?.aborted) return finish();

      const markStarted = () => {
        if (finished || audioStarted) return;
        audioStarted = true;
        start = performance.now();
        onTiming?.({ phase: 'first-audio', source: outcome, firstAudioMs: Math.round(start - requestedAt), audioDurationMs: duration, visemeSource });
      };
      const tick = () => {
        if (finished) return;
        const actualDuration = audio && Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration * 1000 : duration;
        const elapsed = audio ? audio.currentTime * 1000 : performance.now() - start;
        const progress = boundaryIndex === null ? elapsed / actualDuration : boundaryIndex / Math.max(1, text.length);
        onProgress?.(Math.min(1, progress));
        let level = 0;
        if (analyser && !this.muted && !audio?.paused) {
          analyser.getFloatTimeDomainData(analyserSamples);
          level = rmsLevel(analyserSamples);
        }
        onLevel?.(level);
        const shape = visemeAt(timeline, elapsed, this.muted ? 0 : analyser ? level : outcome === 'browser' ? 0.35 : 0, visemeSource);
        onViseme?.(shape);
        if (outcome === 'silent' && progress >= 1) return finish();
        frame = requestAnimationFrame(tick);
      };
      const silent = ({ notify = true, elapsedMs = 0 } = {}) => {
        if (finished || silentStarted) return;
        silentStarted = true;
        cancelAnimationFrame(frame);
        clearTimeout(watchdog);
        cleanupMedia();
        outcome = 'silent';
        boundaryIndex = null;
        start = performance.now() - elapsedMs;
        if (notify) onFallback?.();
        frame = requestAnimationFrame(tick);
      };
      const browser = () => {
        if (finished || usingBrowser) return;
        usingBrowser = true;
        cancelAnimationFrame(frame);
        clearTimeout(watchdog);
        cleanupMedia();
        if (this.muted) return silent({ notify: false });
        const synth = window.speechSynthesis;
        const voice = synth?.getVoices().find((item) => item.lang.startsWith('zh'));
        if (!synth || !voice) return silent();
        outcome = 'browser';
        utterance = new SpeechSynthesisUtterance(text);
        this.currentUtterance = utterance;
        utterance.voice = voice;
        utterance.lang = 'zh-CN';
        utterance.rate = 0.95;
        utterance.volume = this.outputVolume;
        utterance.onstart = markStarted;
        utterance.onboundary = (event) => {
          if (finished) return;
          boundaryIndex = event.charIndex;
          onProgress?.(Math.min(1, (event.charIndex + (event.charLength || 1)) / text.length));
        };
        utterance.onend = finish;
        utterance.onerror = () => { if (!finished) silent(); };
        muteBrowser = () => {
          if (finished || outcome !== 'browser') return;
          const elapsedMs = Math.min(duration, Math.max(performance.now() - start, (boundaryIndex || 0) / text.length * duration));
          // Web Speech does not reliably apply volume changes to an active utterance.
          utterance.onend = null; utterance.onerror = null; utterance.onboundary = null;
          synth.cancel();
          if (this.currentUtterance === utterance) this.currentUtterance = null;
          silent({ notify: false, elapsedMs });
        };
        this.muteCurrent = muteBrowser;
        synth.speak(utterance);
        frame = requestAnimationFrame(tick);
        watchdog = setTimeout(finish, Math.max(12000, duration * 3));
      };
      const attachAnalysis = async (element) => {
        const context = await this.unlock();
        if (finished || audio !== element || !context || context.state !== 'running') return;
        try {
          mediaNode = context.createMediaElementSource(element);
          analyser = context.createAnalyser();
          analyser.fftSize = 512;
          analyser.smoothingTimeConstant = 0.3;
          analyserSamples = new Float32Array(analyser.fftSize);
          mediaNode.connect(analyser);
          analyser.connect(context.destination);
        } catch { analyser = null; }
      };
      const playUrl = async (url, streaming = false) => {
        if (finished) return;
        audio = new Audio(url);
        this.currentAudio = audio;
        const element = audio;
        this.applyVolume();
        audio.preload = 'auto';
        audio.onended = finish;
        audio.onplaying = markStarted;
        audio.ondurationchange = () => {
          if (finished || !Number.isFinite(element.duration) || element.duration <= 0) return;
          duration = element.duration * 1000;
          if (!timing?.cues && !this.timing[text]?.cues) timeline = createVisemeTimeline(text, duration);
        };
        audio.onerror = () => { if (!finished) browser(); };
        try {
          outcome = streaming ? 'stream' : 'recording';
          attachAnalysis(element);
          await audio.play();
          if (finished || usingBrowser || silentStarted) return;
          markStarted();
          frame = requestAnimationFrame(tick);
          watchdog = setTimeout(finish, 90000);
        } catch { if (!finished) browser(); }
      };
      const streamedTts = async () => {
        const response = await fetch('/api/tts/stream', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }), signal: transport.signal,
        });
        if (!response.ok) throw new Error('tts');
        if (finished) return;
        const MediaSource = window.MediaSource;
        if (!response.body?.getReader || !MediaSource?.isTypeSupported?.('audio/mpeg')) {
          const blob = await response.blob();
          if (finished) return;
          objectUrl = URL.createObjectURL(blob);
          return playUrl(objectUrl);
        }
        mediaSource = new MediaSource();
        objectUrl = URL.createObjectURL(mediaSource);
        const queue = [];
        let ended = false;
        const append = () => {
          if (finished || usingBrowser || !sourceBuffer || sourceBuffer.updating || mediaSource.readyState !== 'open') return;
          try {
            if (queue.length) sourceBuffer.appendBuffer(queue.shift());
            else if (ended) mediaSource.endOfStream();
          } catch { browser(); }
        };
        mediaSource.addEventListener('sourceopen', () => {
          if (finished || usingBrowser) return;
          try {
            sourceBuffer = mediaSource.addSourceBuffer('audio/mpeg');
            sourceBuffer.mode = 'sequence';
            sourceBuffer.addEventListener('updateend', append);
            sourceBuffer.addEventListener('error', browser, { once: true });
            append();
          } catch { browser(); }
        }, { once: true });
        playUrl(objectUrl, true);
        reader = response.body.getReader();
        while (!finished && !usingBrowser) {
          const chunk = await reader.read();
          if (finished || usingBrowser) return;
          if (chunk.done) { ended = true; append(); break; }
          if (!firstPacket) { firstPacket = true; onTiming?.({ phase: 'first-packet', source: 'stream', firstPacketMs: Math.round(performance.now() - requestedAt) }); }
          queue.push(chunk.value);
          append();
        }
      };
      if (this.muted) frame = requestAnimationFrame(tick);
      else if (this.manifest[text]) playUrl(this.manifest[text]);
      else if (serverTts) streamedTts().catch(() => { if (!finished && !usingBrowser) browser(); });
      else browser();
    });
  }
}

export function createRainSound() {
  const AudioContext = window.AudioContext || window.webkitAudioContext;
  if (!AudioContext) return null;
  const context = new AudioContext();
  const buffer = context.createBuffer(1, context.sampleRate * 3, context.sampleRate);
  const samples = buffer.getChannelData(0);
  for (let i = 0; i < samples.length; i++) samples[i] = (Math.random() * 2 - 1) * 0.25;
  const source = context.createBufferSource(); source.buffer = buffer; source.loop = true;
  const filter = context.createBiquadFilter(); filter.type = 'lowpass'; filter.frequency.value = 900;
  const gain = context.createGain(); gain.gain.value = 0.11;
  source.connect(filter).connect(gain).connect(context.destination); source.start(); context.resume();
  return { stop: () => { source.stop(); context.close(); } };
}
