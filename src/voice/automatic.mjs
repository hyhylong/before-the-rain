import { createUtteranceGate } from './utterance.mjs';

function microphoneError(message, code = 'VOICE_UNAVAILABLE') {
  const error = new Error(message); error.code = code; return error;
}

function normalize(text) { return text.toLowerCase().replace(/[\s，。！？、,.!?;；：:~～]/g, ''); }

export function createAutomaticVoice(options = {}) {
  const { onSpeechStart, onSpeechEnd, onTranscript, onBackchannel, onError, getPlaybackState } = options;
  let vad;
  let context;
  let stream;
  let recognition;
  let restartTimer;
  let finalTimer;
  let pendingStt;
  let enabled = false;
  let generation = 0;
  let utterance = 0;
  let playback = false;
  let speechStartedAt = 0;
  let lastVoicedAt = 0;
  let recognitionResults = [];
  let consumedResults = 0;
  let currentText = '';
  let recognitionWorks = false;
  let warnedRecognition = false;
  let library;
  const now = () => performance.now();
  const playbackState = () => getPlaybackState?.() ?? playback;
  const playing = () => { const state = playbackState(); return typeof state === 'object' ? Boolean(state.speaking) : Boolean(state); };
  const echo = (text) => {
    const state = playbackState();
    if (!state || typeof state !== 'object' || !state.speaking || !state.text) return false;
    const candidate = normalize(text);
    return candidate.length >= 5 && normalize(state.text).includes(candidate);
  };
  const gate = createUtteranceGate({
    onCandidate: onSpeechStart,
    onInterrupt: onSpeechStart,
    onBackchannel,
    minSpeechMs: options.minSpeechMs ?? 650,
  });
  const releaseTracks = () => { stream?.getTracks().forEach((track) => track.stop()); stream = null; };
  const getStream = async (run = generation) => {
    if (!enabled || run !== generation) throw new DOMException('Stopped', 'AbortError');
    if (stream?.active) return stream;
    const acquired = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    if (!enabled || run !== generation) { acquired.getTracks().forEach((track) => track.stop()); throw new DOMException('Stopped', 'AbortError'); }
    stream = acquired;
    return stream;
  };

  function startRecognition(run) {
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition || !enabled || run !== generation) return;
    const instance = new Recognition();
    recognition = instance;
    recognitionResults = []; consumedResults = 0;
    instance.lang = 'zh-CN'; instance.interimResults = true; instance.continuous = true;
    instance.onresult = (event) => {
      if (!enabled || run !== generation || recognition !== instance) return;
      recognitionWorks = true;
      recognitionResults = Array.from(event.results).map((result) => ({ text: result[0].transcript, final: result.isFinal }));
      if (!gate.active) { consumedResults = recognitionResults.length; return; }
      currentText = recognitionResults.slice(consumedResults).map((result) => result.text).join('');
      if (!echo(currentText)) gate.transcript(currentText, now());
    };
    instance.onerror = (event) => {
      if (!enabled || run !== generation || event.error === 'aborted' || event.error === 'no-speech') return;
      recognitionWorks = false;
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        if (!warnedRecognition) {
          warnedRecognition = true;
          onError?.(microphoneError('浏览器语音识别未获授权，将尝试服务端识别。', 'RECOGNITION_UNAVAILABLE'));
        }
      }
    };
    instance.onend = () => {
      if (!enabled || run !== generation || recognition !== instance) return;
      recognition = null;
      restartTimer = setTimeout(() => startRecognition(run), 350);
    };
    try { instance.start(); recognitionWorks = true; } catch { recognitionWorks = false; }
  }

  async function endSpeech(audio, run, segment) {
    if (!enabled || run !== generation || segment !== utterance) return;
    const endedAt = lastVoicedAt || now();
    let text = currentText.trim();
    try {
      if (!text && options.serverSttAvailable !== false) {
        const controller = new AbortController();
        pendingStt = controller;
        const timeout = setTimeout(() => controller.abort(), 20000);
        try {
          const body = new FormData();
          body.append('audio', new Blob([library.utils.encodeWAV(audio)], { type: 'audio/wav' }), 'automatic.wav');
          const response = await fetch('/api/stt', { method: 'POST', body, signal: controller.signal });
          const result = await response.json();
          if (!response.ok || !result.text) throw microphoneError(result.error?.message || '这一段没有听清，请再说一次。', 'TRANSCRIPTION_FAILED');
          text = result.text.trim();
        } finally { clearTimeout(timeout); }
      }
      if (!enabled || run !== generation || segment !== utterance) return;
      if (echo(text)) {
        gate.cancel();
        onBackchannel?.({ text, durationMs: endedAt - speechStartedAt, reason: 'echo' });
        onSpeechEnd?.({ text: '', backchannel: true, interrupted: false, durationMs: endedAt - speechStartedAt, reason: 'echo' });
        return;
      }
      const result = gate.end(endedAt, text);
      onSpeechEnd?.(result);
      if (result.text.trim()) onTranscript?.({ text: result.text.trim(), durationMs: result.durationMs });
      else if (!text && !recognitionWorks && options.serverSttAvailable === false) {
        onError?.(microphoneError('自动倾听已检测到声音，但没有可用的语音识别服务。', 'TRANSCRIPTION_UNAVAILABLE'));
      }
    } catch (error) {
      if (!enabled || run !== generation || segment !== utterance || error.name === 'AbortError') return;
      gate.cancel();
      onSpeechEnd?.({ text: '', backchannel: false, interrupted: false, durationMs: endedAt - speechStartedAt });
      onError?.(error);
    } finally {
      if (segment === utterance) consumedResults = recognitionResults.length;
    }
  }

  return {
    async start() {
      if (enabled) return;
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw microphoneError('自动倾听需要 HTTPS 或 localhost，以及麦克风权限。', 'INSECURE_CONTEXT');
      enabled = true;
      const run = ++generation;
      const Context = window.AudioContext || window.webkitAudioContext;
      try {
        if (Context) { context = new Context(); await context.resume(); }
        library = options.loadVad ? await options.loadVad() : await import('@ricky0123/vad-web');
        if (!enabled || run !== generation) return;
        const instance = await library.MicVAD.new({
          model: 'v5', startOnLoad: false, audioContext: context,
          baseAssetPath: '/vad/', onnxWASMBasePath: '/vad/',
          positiveSpeechThreshold: 0.6, negativeSpeechThreshold: 0.35,
          minSpeechMs: 250, redemptionMs: 650, preSpeechPadMs: 300,
          submitUserSpeechOnPause: false,
          getStream: () => getStream(run),
          pauseStream: async (activeStream) => { activeStream.getTracks().forEach((track) => track.stop()); if (stream === activeStream) stream = null; },
          resumeStream: () => getStream(run),
          ortConfig: (ort) => { ort.env.logLevel = 'error'; ort.env.wasm.numThreads = 1; ort.env.wasm.proxy = false; },
          onSpeechStart: () => {
            if (!enabled || run !== generation) return;
            pendingStt?.abort(); clearTimeout(finalTimer);
            utterance += 1; currentText = ''; speechStartedAt = now(); lastVoicedAt = speechStartedAt;
            consumedResults = recognitionResults.length;
            gate.begin(speechStartedAt, playing());
            if (!playing()) onSpeechStart?.({ phase: 'listening', durationMs: 0, text: '' });
          },
          onFrameProcessed: (probabilities) => {
            if (!enabled || run !== generation || !gate.active || probabilities.isSpeech < 0.6) return;
            lastVoicedAt = now();
            if (!echo(currentText)) gate.tick(lastVoicedAt);
          },
          onSpeechRealStart: () => { if (gate.active && currentText && !echo(currentText)) gate.transcript(currentText, now()); },
          onVADMisfire: () => {
            if (!enabled || run !== generation) return;
            gate.cancel(); consumedResults = recognitionResults.length;
            onSpeechEnd?.({ text: '', backchannel: true, interrupted: false, durationMs: Math.max(0, lastVoicedAt - speechStartedAt), reason: 'noise' });
          },
          onSpeechEnd: (audio) => {
            const segment = utterance;
            finalTimer = setTimeout(() => endSpeech(audio, run, segment), options.finalGraceMs ?? 450);
          },
        });
        if (!enabled || run !== generation) { await instance.destroy(); return; }
        vad = instance;
        await vad.start();
        if (!enabled || run !== generation) return;
        startRecognition(run);
      } catch (error) {
        if (run !== generation) return;
        enabled = false; generation += 1; releaseTracks();
        await vad?.destroy().catch(() => {}); vad = null;
        await context?.close().catch(() => {}); context = null;
        throw error;
      }
    },
    async stop() {
      enabled = false; generation += 1; utterance += 1;
      clearTimeout(restartTimer); clearTimeout(finalTimer); pendingStt?.abort(); gate.cancel();
      if (recognition) { recognition.onend = null; recognition.onresult = null; recognition.onerror = null; recognition.abort(); recognition = null; }
      releaseTracks();
      const instance = vad; vad = null;
      const audioContext = context; context = null;
      await instance?.destroy().catch(() => {});
      await audioContext?.close().catch(() => {});
      onSpeechEnd?.({ text: '', backchannel: false, interrupted: false, durationMs: 0, reason: 'stopped' });
    },
    setPlayback(value) { playback = Boolean(value); },
    get active() { return enabled; },
  };
}
