import { useCallback, useEffect, useRef, useState } from 'react';
import { TurnScope } from './turn-scope.mjs';
import { INTRO, SpeechPlayer } from './speech.mjs';
import { LineQueue, readTurnStream, abortableDelay } from './stream.mjs';
import { readJournal } from './journal.mjs';
import useExtensions from './useExtensions.jsx';

const initialChoices = ['这么晚，你在等谁？', '可以看看你的相机吗？', '给你点一杯热咖啡吧'];
const uuid = () => crypto.randomUUID?.() || `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;

export default function useExperience() {
  const saved = useRef(readJournal());
  const [status, setStatus] = useState('idle');
  const [emotion, setEmotion] = useState(saved.current?.emotion || 'curious');
  const [gesture, setGesture] = useState('idle');
  const [weather, setWeather] = useState(saved.current?.weather || 'rain');
  const [effect, setEffect] = useState(null);
  const [photo, setPhoto] = useState(false);
  const [subtitle, setSubtitle] = useState(saved.current?.subtitle || INTRO);
  const [visibleChars, setVisibleChars] = useState((saved.current?.subtitle || INTRO).length);
  const [choices, setChoices] = useState(saved.current?.choices || initialChoices);
  const [chapter, setChapter] = useState(saved.current?.chapter || '初次相遇');
  const [mode, setMode] = useState(saved.current?.mode || 'mock');
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [input, setInput] = useState('');
  const [speakingLevel, setSpeakingLevel] = useState(0);
  const [viseme, setViseme] = useState({ aa: 0, ee: 0, oo: 0, closed: 1, source: 'silent' });
  const [timing, setTiming] = useState(null);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(85);
  const [health, setHealth] = useState({ liveAvailable: false, sttAvailable: false, ttsAvailable: false });
  const [fault, setFault] = useState('none');
  const [events, setEvents] = useState([]);
  const [latency, setLatency] = useState(null);
  const [lastUser, setLastUser] = useState('');
  const scope = useRef(null);
  if (!scope.current) { scope.current = new TurnScope(); scope.current.version = Math.max(Date.now(), saved.current?.turnVersion || 0); }
  const speaker = useRef(new SpeechPlayer());
  const sessionId = useRef(saved.current?.sessionId || uuid());
  const recognition = useRef(null);
  const recorder = useRef(null);
  const micStream = useRef(null);
  const retryMessage = useRef('');
  const currentReply = useRef([{ text: INTRO, emotion: 'curious', gesture: 'idle' }]);
  const mounted = useRef(true);
  const warnedAudio = useRef(false);
  const extensionsRef = useRef(null);

  const log = useCallback((kind, detail) => {
    if (mounted.current) setEvents((items) => [...items.slice(-149), { time: new Date().toISOString(), kind, detail }]);
  }, []);

  const stopMic = useCallback(() => {
    if (recognition.current) {
      recognition.current.onend = null;
      recognition.current.onresult = null;
      recognition.current.onerror = null;
      recognition.current.abort();
      recognition.current = null;
    }
    if (recorder.current?.state === 'recording') {
      recorder.current.onstop = null;
      recorder.current.stop();
    }
    recorder.current = null;
    micStream.current?.getTracks().forEach((track) => track.stop());
    micStream.current = null;
  }, []);

  const interrupt = useCallback((reason = 'user') => {
    scope.current.cancel();
    speaker.current.stop();
    stopMic();
    setSpeakingLevel(0);
    setViseme({ aa: 0, ee: 0, oo: 0, closed: 1, source: 'silent' });
    setGesture('idle');
    setEffect(null);
    setPhoto(false);
    setStatus('idle');
    extensionsRef.current?.onInterrupt(reason);
    log('interrupt', reason);
  }, [log, stopMic]);

  useEffect(() => {
    mounted.current = true;
    speaker.current.load();
    const controller = new AbortController();
    fetch('/api/health', { signal: controller.signal })
      .then((response) => { if (!response.ok) throw new Error(); return response.json(); })
      .then((data) => setHealth(data))
      .catch((err) => { if (err.name !== 'AbortError') setNotice('暂时无法连接咖啡馆，发送消息时会重新连接。'); });
    return () => { mounted.current = false; controller.abort(); scope.current.cancel(); speaker.current.stop(); stopMic(); };
  }, [stopMic]);

  useEffect(() => { speaker.current.volume = volume / 100; }, [volume]);
  useEffect(() => { speaker.current.muted = muted; }, [muted]);

  const perform = useCallback(async (lines, turn, options = {}) => {
    if (Array.isArray(lines)) currentReply.current = lines.map((entry) => entry.line || entry);
    let position = 0;
    for await (const entry of lines) {
      if (!scope.current.current(turn.id)) return;
      const line = entry.line || entry;
      const index = entry.index ?? position++;
      if (entry.serverTurnId !== undefined) {
        const ack = await fetch('/api/session/ack', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: sessionId.current, turnId: entry.serverTurnId, lineIndex: index }), signal: turn.signal });
        if (!scope.current.current(turn.id)) return;
        if (!ack.ok) throw new Error('这段回复已失效，请重新交流。');
      }
      setStatus('speaking');
      setEmotion(line.emotion);
      setGesture(line.gesture);
      setSubtitle(line.text);
      setVisibleChars(0);
      if (line.scene) setWeather(line.scene);
      if (line.effect) setEffect({ kind: line.effect, id: `${turn.id}-${Date.now()}` });
      const started = performance.now();
      const lineController = new AbortController();
      const cancel = () => lineController.abort();
      turn.signal.addEventListener('abort', cancel, { once: true });
      const limit = options.replay && entry.complete === false && entry.durationMs > 0 ? setTimeout(cancel, entry.durationMs) : null;
      const record = extensionsRef.current?.onLineStart(line, { ...turn, signal: lineController.signal }, index, options);
      log('line', { text: line.text, emotion: line.emotion, gesture: line.gesture, scene: line.scene, media: line.media });
      try {
        await extensionsRef.current?.waitForVideo(turn);
        if (!scope.current.current(turn.id)) return;
        if (lineController.signal.aborted) continue;
        if (line.media === 'photo') setPhoto(true);
        await speaker.current.play(line.text, {
        signal: lineController.signal,
        serverTts: health.ttsAvailable,
        onProgress: (progress) => { if (scope.current.current(turn.id)) setVisibleChars(Math.min(line.text.length, Math.ceil(progress * line.text.length) + 1)); },
        onLevel: (level) => { if (scope.current.current(turn.id)) setSpeakingLevel(level); },
        onViseme: (value) => { if (scope.current.current(turn.id)) setViseme(value); },
        onTiming: (value) => { if (scope.current.current(turn.id)) { setTiming(value); log('audio-timing', value); } },
        onFallback: () => {
          if (!scope.current.current(turn.id) || warnedAudio.current) return;
          warnedAudio.current = true;
          setNotice('语音暂不可用，字幕会继续播放。');
          log('audio-fallback', '字幕播放');
        },
      }); } finally {
        clearTimeout(limit); turn.signal.removeEventListener('abort', cancel);
        extensionsRef.current?.onLineEnd(record, { durationMs: Math.min(120000, performance.now() - started), complete: scope.current.current(turn.id) && !lineController.signal.aborted });
      }
      if (!scope.current.current(turn.id)) return;
      setVisibleChars(line.text.length);
      setEffect(null);
    }
    if (!scope.current.current(turn.id)) return;
    setStatus('idle');
    setGesture('idle');
    setSpeakingLevel(0);
    setViseme({ aa: 0, ee: 0, oo: 0, closed: 1, source: 'silent' });
    extensionsRef.current?.onTurnComplete();
    log('turn-complete', turn.id);
  }, [health.ttsAvailable, log]);

  const send = useCallback(async (message) => {
    const text = message.trim();
    if (!text) return;
    void speaker.current.unlock();
    interrupt('new-input');
    const turn = scope.current.next();
    const start = performance.now();
    setError(null);
    setNotice(null);
    setInput('');
    setLastUser(text);
    setStatus('thinking');
    setSubtitle('');
    setChoices([]);
    retryMessage.current = text;
    extensionsRef.current?.onNewTurn(text, turn);
    log('turn-start', { turnId: turn.id, mode, message: text });
    const requestFault = fault;
    setFault('none');
    const queue = new LineQueue();
    const removeQueue = scope.current.addCleanup(() => queue.close());
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; scope.current.controller?.abort(); }, 25000);
    const removeCleanup = scope.current.addCleanup(() => clearTimeout(timer));
    const streaming = extensionsRef.current?.streaming ?? true;
    const acceptFinal = (data) => {
      if (!scope.current.current(turn.id)) return;
      clearTimeout(timer);
      setLatency(Math.round(performance.now() - start)); setChapter(data.chapter); setChoices(data.choices || []);
      currentReply.current = data.lines;
      speaker.current.prefetch(data.lines.map((line) => line.text));
      extensionsRef.current?.onReply(data, turn);
      log('reply-received', { turnId: turn.id, latencyMs: Math.round(performance.now() - start), timing: data.timing });
    };
    let nextIndex = 0;
    const receive = async () => {
      const response = await fetch(streaming ? '/api/turn/stream' : '/api/turn', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: turn.signal,
        body: JSON.stringify({ sessionId: sessionId.current, turnId: turn.id, message: text, mode, fault: requestFault }),
      });
      if (!streaming) {
        const data = await response.json();
        if (!scope.current.current(turn.id)) return;
        if (!response.ok) throw new Error(data.error?.message || '连接暂时中断，请重试。');
        acceptFinal(data); data.lines.forEach((line, index) => queue.push({ line, index })); queue.close(); return;
      }
      await readTurnStream(response, (event) => {
        if (!scope.current.current(turn.id) || event.turnId !== turn.id) return;
        if (event.type === 'line') {
          if (event.index !== nextIndex) throw new Error('回复顺序异常，请重试。');
          nextIndex++;
          extensionsRef.current?.onStreamLine(event.line, turn);
          if (event.index === 0) { setLatency(Math.round(performance.now() - start)); log('first-line', Math.round(performance.now() - start)); }
          queue.push({ line: event.line, index: event.index, serverTurnId: turn.id });
        } else if (event.type === 'final') { acceptFinal(event); queue.close(); }
      }, turn.signal);
    };
    const receiveWithRecovery = async () => {
      try { await receive(); }
      catch (err) {
        if (turn.signal.aborted || requestFault !== 'none' || err.retryConnection === false) throw err;
        extensionsRef.current?.setConnection('reconnecting');
        for (let attempt = 0; attempt < 3; attempt++) {
          await abortableDelay(500 * (attempt + 1), turn.signal);
          const response = await fetch(`/api/session/${sessionId.current}`, { signal: turn.signal }).catch(() => null);
          if (!scope.current.current(turn.id)) return;
          const data = response?.ok ? await response.json() : null;
          if (data?.latestReply?.turnId === turn.id && data.latestReply.complete) {
            data.latestReply.lines.slice(nextIndex).forEach((line, offset) => queue.push({ line, index: nextIndex + offset, serverTurnId: turn.id }));
            acceptFinal(data.latestReply); queue.close(); log('connection-recovered', turn.id); return;
          }
        }
        throw err;
      }
    };
    try {
      await Promise.all([receiveWithRecovery().catch((err) => { queue.fail(err); throw err; }), perform(queue, turn)]);
    } catch (err) {
      if (!scope.current.current(turn.id)) return;
      if (err.name === 'AbortError' && !timedOut) return;
      scope.current.cancel(); speaker.current.stop(); queue.close(); setPhoto(false); extensionsRef.current?.onInterrupt('stream-error');
      setStatus('idle');
      setError(timedOut ? '等得有点久了。再试着叫她一声吧。' : err.message === 'Failed to fetch' ? '连接中断了，你的话还在。' : err.message);
      setSubtitle('');
      setChoices(initialChoices);
      log('error', timedOut ? 'request-timeout' : err.message);
    } finally { clearTimeout(timer); removeCleanup(); removeQueue(); }
  }, [fault, interrupt, log, mode, perform]);

  const startMic = useCallback(async () => {
    extensionsRef.current?.stopAutomatic();
    if (status === 'listening') {
      if (recognition.current) recognition.current.stop();
      else if (recorder.current?.state === 'recording') recorder.current.stop();
      else interrupt('microphone-cancel');
      return;
    }
    interrupt('microphone');
    void speaker.current.unlock();
    const turn = scope.current.next();
    setError(null);
    setNotice(null);
    setStatus('listening');
    setInput('');
    log('listening', turn.id);
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (Recognition) {
      const instance = new Recognition();
      recognition.current = instance;
      instance.lang = 'zh-CN'; instance.interimResults = true; instance.continuous = false;
      let transcript = '';
      let failed = false;
      instance.onresult = (event) => {
        if (!scope.current.current(turn.id)) return;
        transcript = Array.from(event.results).map((result) => result[0].transcript).join('');
        setInput(transcript);
      };
      instance.onerror = (event) => {
        if (!scope.current.current(turn.id)) return;
        failed = true;
        setStatus('idle');
        const messages = { 'not-allowed': '麦克风未获授权，可以在浏览器设置中开启。', 'audio-capture': '没有检测到麦克风，可以先用文字交流。', network: '语音识别连接失败，可以先用文字交流。', 'no-speech': '刚才没有听清，再说一次吧。' };
        setNotice(messages[event.error] || '暂时无法识别语音，可以先用文字交流。');
        log('microphone-error', event.error);
      };
      instance.onend = () => {
        if (!scope.current.current(turn.id)) return;
        recognition.current = null;
        if (!failed && transcript.trim()) send(transcript);
        else setStatus('idle');
      };
      try { instance.start(); } catch { instance.onerror({ error: 'audio-capture' }); }
      return;
    }
    if (!health.sttAvailable || !navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      setStatus('idle');
      setNotice(!window.isSecureContext ? '麦克风需要 HTTPS 或 localhost 连接。当前可以用文字交流。' : '当前浏览器没有语音识别服务，可以先用文字交流，或连接语音服务。');
      log('microphone-unavailable', 'no-recognition-provider');
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      if (!scope.current.current(turn.id)) { stream.getTracks().forEach((track) => track.stop()); return; }
      micStream.current = stream;
      const instance = new MediaRecorder(stream);
      recorder.current = instance;
      const chunks = [];
      instance.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      instance.onerror = () => {
        if (!scope.current.current(turn.id)) return;
        stopMic();
        setStatus('idle');
        setNotice('录音中断了，可以重新录音或用文字交流。');
        log('microphone-error', 'recorder-failed');
      };
      instance.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());
        if (!scope.current.current(turn.id)) return;
        setStatus('thinking');
        const form = new FormData();
        form.append('audio', new Blob(chunks, { type: instance.mimeType }), 'voice.webm');
        try {
          const response = await fetch('/api/stt', { method: 'POST', body: form, signal: turn.signal });
          const data = await response.json();
          if (!scope.current.current(turn.id)) return;
          if (!response.ok || !data.text) throw new Error(data.error?.message || '没有听清，再试一次吧。');
          send(data.text);
        } catch (err) { if (scope.current.current(turn.id)) { setNotice(err.message); setStatus('idle'); } }
      };
      instance.start();
      const timer = setTimeout(() => { if (scope.current.current(turn.id) && instance.state === 'recording') instance.stop(); }, 45000);
      scope.current.addCleanup(() => clearTimeout(timer));
    } catch (err) {
      if (scope.current.current(turn.id)) { setStatus('idle'); setNotice(err.name === 'NotAllowedError' ? '麦克风未获授权，可以先用文字交流。' : '无法打开麦克风，可以先用文字交流。'); }
    }
  }, [health.sttAvailable, interrupt, log, send, status, stopMic]);

  const replay = useCallback(async () => {
    void speaker.current.unlock();
    interrupt('replay');
    const turn = scope.current.next();
    await perform(currentReply.current, turn, { replay: true });
  }, [interrupt, perform]);

  const reset = useCallback(() => {
    interrupt('reset');
    const previousSession = sessionId.current;
    sessionId.current = uuid();
    currentReply.current = [{ text: INTRO, emotion: 'curious', gesture: 'idle' }];
    extensionsRef.current?.onReset();
    fetch('/api/session/reset', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: previousSession }) }).catch(() => {});
    setSubtitle(INTRO); setVisibleChars(INTRO.length); setEmotion('curious'); setWeather('rain');
    setChoices(initialChoices); setChapter('初次相遇'); setLastUser(''); setInput(''); setError(null); setNotice(null); setLatency(null);
  }, [interrupt]);

  const switchMode = useCallback((nextMode) => { if (nextMode !== mode) { reset(); setMode(nextMode); } }, [mode, reset]);
  const toggleMute = useCallback(() => { setMuted((value) => !value); }, []);
  const extensions = useExtensions({ saved: saved.current, status, emotion, weather, subtitle, choices, chapter, mode, lastUser, health, scope, speaker, sessionId, currentReply, mounted, log, send, perform, interrupt, stopMic, setStatus, setEmotion, setWeather, setSubtitle, setVisibleChars, setChoices, setChapter, setMode, setNotice, setError, setPhoto, setLastUser, setEffect });
  extensionsRef.current = extensions;
  return { status, emotion, gesture, weather, effect, photo, setPhoto, subtitle, visibleChars, choices, chapter, mode, switchMode, error, notice, setNotice, input, setInput, speakingLevel, viseme, timing, muted, toggleMute, volume, setVolume, health, fault, setFault, events, latency, lastUser, send, startMic, interrupt, replay, reset, retry: () => send(retryMessage.current), ...extensions.public };
}
