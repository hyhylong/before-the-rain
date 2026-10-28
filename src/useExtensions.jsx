import { useCallback, useEffect, useRef, useState } from 'react';
import { TurnScope } from './turn-scope.mjs';
import { abortableDelay } from './stream.mjs';
import { parseJournal, saveJournal } from './journal.mjs';

const uuid = () => crypto.randomUUID?.() || `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const post = (url, body, signal) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });

export default function useExtensions(base) {
  const latest = useRef(base); latest.current = base;
  const [streaming, setStreaming] = useState(true);
  const [cinematics, setCinematics] = useState(true);
  const [video, setVideo] = useState(null);
  const [generatedImage, setGeneratedImage] = useState(null);
  const [journal, setJournal] = useState(base.saved?.turns || []);
  const [connection, setConnection] = useState('connecting');
  const [hasResume, setHasResume] = useState(false);
  const [replayActive, setReplayActive] = useState(false);
  const [automaticEnabled, setAutomaticEnabled] = useState(false);
  const [automaticState, setAutomaticState] = useState('off');
  const [voiceDucked, setVoiceDucked] = useState(false);
  const videoNarration = useRef({ speaking: false, text: '' });
  const [mediaMode, setMediaMode] = useState('mock');
  const [automaticMedia, setAutomaticMedia] = useState(false);
  const [mediaJob, setMediaJob] = useState(null);
  const [mediaCapabilities, setMediaCapabilities] = useState({ imageAvailable: false, videoAvailable: false });
  const records = useRef(base.saved?.turns || []);
  const activeRecord = useRef(null);
  const resumeData = useRef(null);
  const restorePending = useRef(Boolean(base.saved && base.saved.status !== 'idle'));
  const automatic = useRef(null);
  const autoVersion = useRef(0);
  const mediaScope = useRef(new TurnScope());
  const mediaId = useRef(null);
  const lastMediaRequest = useRef(null);
  const videoCompletion = useRef(null);
  const closeVideo = useCallback(() => {
    setVideo(null); videoNarration.current = { speaking: false, text: '' }; videoCompletion.current?.resolve(); videoCompletion.current = null;
  }, []);
  const snapshot = () => {
    const b = latest.current;
    return { version: 2, sessionId: b.sessionId.current, turnVersion: b.scope.current.version, mode: b.mode, weather: b.weather, emotion: b.emotion, subtitle: b.subtitle, chapter: b.chapter, choices: b.choices, status: restorePending.current && b.status === 'idle' ? 'speaking' : b.status, turns: records.current.slice(-100) };
  };
  const persist = () => { if (latest.current.mounted.current) { setJournal([...records.current]); saveJournal(snapshot()); } };
  useEffect(() => { saveJournal(snapshot()); }, [base.status, base.emotion, base.weather, base.subtitle, base.chapter, base.choices, base.mode, journal]);

  const cancelMedia = useCallback((clear = true) => {
    mediaScope.current.cancel();
    const id = mediaId.current; mediaId.current = null;
    if (id) fetch(`/api/media/jobs/${id}`, { method: 'DELETE' }).catch(() => {});
    if (clear && latest.current.mounted.current) { setMediaJob(null); setGeneratedImage(null); }
  }, []);
  const stopAutomatic = useCallback(() => {
    autoVersion.current++;
    void automatic.current?.stop(); automatic.current = null;
    latest.current.speaker.current.setDucked(false);
    if (latest.current.mounted.current) { setVoiceDucked(false); setAutomaticEnabled(false); setAutomaticState('off'); }
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    const initialVersion = latest.current.scope.current.version;
    const connect = async (restore = false) => {
      try {
        const response = await fetch('/api/media/capabilities', { signal: controller.signal });
        if (!response.ok) throw new Error('connection');
        setMediaCapabilities(await response.json()); setConnection('online');
        const b = latest.current;
        if (restore && b.saved) {
          const response = await fetch(`/api/session/${b.sessionId.current}`, { signal: controller.signal });
          if (b.scope.current.version !== initialVersion) return;
          if (response.ok) {
            const data = await response.json();
            if (b.scope.current.version !== initialVersion) return;
            b.scope.current.version = Math.max(b.scope.current.version, data.lastTurnId + 1);
            if (data.state?.scene) b.setWeather(data.state.scene);
            if (data.latestReply?.lines?.length) {
              b.currentReply.current = data.latestReply.lines;
              if (b.saved.status !== 'idle' || data.acknowledgedLine < data.latestReply.lines.length - 1) { resumeData.current = data; restorePending.current = true; setHasResume(true); b.setNotice(data.latestReply.complete ? '上次的话还没说完，已经替你留着。' : '已找回中断前的片段，可以重听或继续聊。'); }
              else b.setNotice('已找回上次的相遇。');
            }
          } else if (response.status === 404) b.setNotice('已找回本地会话，可以继续交流或回放。');
        }
      } catch (error) { if (error.name !== 'AbortError') setConnection('offline'); }
    };
    void connect(true);
    const offline = () => { setConnection('offline'); latest.current.log('connection', 'offline'); };
    const online = () => { setConnection('reconnecting'); void connect(); };
    window.addEventListener('offline', offline); window.addEventListener('online', online);
    return () => { controller.abort(); videoCompletion.current?.resolve(); videoCompletion.current = null; cancelMedia(false); stopAutomatic(); window.removeEventListener('offline', offline); window.removeEventListener('online', online); };
  }, [cancelMedia, stopAutomatic]);

  const onInterrupt = (reason) => {
    restorePending.current = false; setHasResume(false);
    cancelMedia(); closeVideo(); setReplayActive(false);
    if (['reset', 'import'].includes(reason)) stopAutomatic();
  };
  const onNewTurn = (text, turn) => {
    const record = { id: turn.id, user: text, chapter: '', timestamp: new Date().toISOString(), lines: [], played: [], choices: [] };
    records.current = [...records.current.slice(-99), record]; activeRecord.current = record; setHasResume(false); persist();
  };
  const onReply = (reply, turn) => {
    setConnection('online');
    const record = records.current.find((item) => item.id === turn.id);
    if (record) { record.lines = reply.lines; record.choices = reply.choices || []; record.chapter = reply.chapter; persist(); }
  };
  const onStreamLine = (line, turn) => {
    const record = records.current.find((item) => item.id === turn.id);
    if (record) record.lines.push(line);
  };
  const onLineStart = (line, turn, index, options) => {
    const generateKind = !options.replay && automaticMedia && mediaMode === 'live' ? line.video && mediaCapabilities.videoAvailable ? 'video' : line.media === 'photo' && mediaCapabilities.imageAvailable ? 'image' : null : null;
    if (generateKind) void startMedia(generateKind, undefined, true, line);
    else if (line.video && cinematics) {
      closeVideo();
      let resolve;
      const promise = new Promise((done) => { resolve = done; });
      videoCompletion.current = { promise, resolve, turnId: turn.id };
      setVideo({ clip: line.video, signal: turn.signal, id: `${turn.id}-${index}` });
    }
    if (options.replay) return null;
    const record = records.current.find((item) => item.id === (options.recordTurnId ?? turn.id));
    const played = { line, index, durationMs: 0, complete: false };
    record?.played.push(played); persist(); return played;
  };
  const onLineEnd = (record, result) => { if (record) { Object.assign(record, result); persist(); } };
  const waitForVideo = (turn) => videoCompletion.current?.turnId === turn.id ? videoCompletion.current.promise : Promise.resolve();
  const onTurnComplete = () => { restorePending.current = false; setReplayActive(false); persist(); };
  const onReset = () => { stopAutomatic(); records.current = []; activeRecord.current = null; resumeData.current = null; restorePending.current = false; setHasResume(false); persist(); };

  const toggleAutomatic = useCallback(async (enabled) => {
    if (!enabled) { stopAutomatic(); if (latest.current.status === 'listening') latest.current.setStatus('idle'); return; }
    if (latest.current.status === 'listening') latest.current.interrupt('automatic-enable');
    else latest.current.stopMic();
    const version = ++autoVersion.current; setAutomaticEnabled(true); setAutomaticState('starting');
    void latest.current.speaker.current.unlock();
    try {
      const { createAutomaticVoice } = await import('./voice/automatic.mjs');
      if (version !== autoVersion.current) return;
      const handle = createAutomaticVoice({
        serverSttAvailable: latest.current.health.sttAvailable,
        getPlaybackState: () => videoNarration.current.speaking ? videoNarration.current : ({ speaking: latest.current.status === 'speaking', text: latest.current.subtitle }),
        onSpeechStart: (event) => {
          if (version !== autoVersion.current) return;
          const b = latest.current;
          if (event.phase === 'candidate') { b.speaker.current.setDucked(true); setVoiceDucked(true); setAutomaticState('candidate'); }
          else { b.interrupt('automatic-speech'); b.setStatus('listening'); setAutomaticState('listening'); }
          b.log('vad-speech', event);
        },
        onSpeechEnd: (event) => { if (version !== autoVersion.current) return; latest.current.speaker.current.setDucked(false); setVoiceDucked(false); setAutomaticState('ready'); if (!event.text && latest.current.status === 'listening') latest.current.setStatus('idle'); },
        onTranscript: ({ text }) => { if (version === autoVersion.current) void latest.current.send(text); },
        onBackchannel: (event) => { if (version === autoVersion.current) { latest.current.speaker.current.setDucked(false); setVoiceDucked(false); latest.current.log('backchannel', event); } },
        onError: (error) => { if (version === autoVersion.current) { latest.current.setNotice(error.message || '自然语音暂不可用，可以使用按钮语音。'); if (!['RECOGNITION_UNAVAILABLE', 'TRANSCRIPTION_FAILED'].includes(error.code)) stopAutomatic(); } },
      });
      automatic.current = handle; await handle.start();
      if (version !== autoVersion.current) { await handle.stop(); return; }
      setAutomaticState('ready'); latest.current.log('automatic-enabled', true);
    } catch (error) { if (version === autoVersion.current) { latest.current.setNotice(error.message || '无法开启自然语音。'); stopAutomatic(); } }
  }, [stopAutomatic]);

  const replaySession = useCallback(async (selectedId) => {
    const entries = selectedId === undefined ? [...records.current] : records.current.filter((item) => item.id === selectedId);
    const b = latest.current;
    if (!entries.some((entry) => entry.played.length)) { b.setNotice('还没有可回放的片段。'); return; }
    void b.speaker.current.unlock(); b.interrupt('session-replay'); setReplayActive(true); b.setError(null); b.setWeather('rain');
    const turn = b.scope.current.next();
    const sequence = async function* () {
      for (const entry of entries) {
        if (!b.scope.current.current(turn.id)) return;
        b.setLastUser(entry.user); b.setChapter(entry.chapter || '回放'); yield* entry.played.filter((played) => played.complete || played.durationMs > 0);
      }
    };
    try { await b.perform(sequence(), turn, { replay: true }); }
    catch { if (b.scope.current.current(turn.id)) { b.setStatus('idle'); setReplayActive(false); b.setNotice('回放中断了，可以重新播放。'); } }
  }, []);
  const resume = useCallback(async () => {
    const data = resumeData.current; if (!data?.latestReply) return;
    const b = latest.current; void b.speaker.current.unlock(); b.interrupt('resume');
    const turn = b.scope.current.next(); const from = Math.max(0, data.acknowledgedLine); setHasResume(false); b.setNotice(null);
    restorePending.current = true;
    if (data.latestReply.chapter) b.setChapter(data.latestReply.chapter);
    if (data.latestReply.choices) b.setChoices(data.latestReply.choices);
    const record = records.current.find((item) => item.id === data.lastTurnId);
    if (record) { record.lines = data.latestReply.lines; record.chapter = data.latestReply.chapter || record.chapter; record.choices = data.latestReply.choices || record.choices; record.played = record.played.filter((entry) => entry.index < from); persist(); }
    try { await b.perform(data.latestReply.lines.slice(from).map((line, offset) => ({ line, index: from + offset, serverTurnId: data.lastTurnId })), turn, { resume: true, recordTurnId: data.lastTurnId }); }
    catch { if (b.scope.current.current(turn.id)) { b.setStatus('idle'); b.setNotice('上次的回复已失效，可以继续交流。'); } }
  }, []);
  const importSession = useCallback(async (text) => {
    const data = parseJournal(text); const b = latest.current;
    b.interrupt('import'); stopAutomatic(); b.sessionId.current = uuid(); records.current = data.turns;
    b.setMode('mock'); b.setWeather(data.weather); b.setEmotion(data.emotion); b.setSubtitle(data.subtitle); b.setVisibleChars(data.subtitle.length); b.setChoices(data.choices); b.setChapter(data.chapter);
    b.currentReply.current = data.turns.at(-1)?.lines.length ? data.turns.at(-1).lines : b.currentReply.current;
    setHasResume(false); b.setNotice('会话已导入，可以回放或开始新的交流。'); persist();
  }, [stopAutomatic]);

  const startMedia = useCallback(async (kind, override, fromStory = false, lineContext) => {
    if (kind === 'video' && !fromStory) latest.current.interrupt('media-video');
    closeVideo();
    cancelMedia(); const token = mediaScope.current.next(); const b = latest.current;
    const conversation = b.scope.current.version; const current = () => mediaScope.current.current(token.id) && conversation === b.scope.current.version;
    setMediaJob({ kind, status: 'queued', progress: 0, source: mediaMode === 'mock' ? 'replay' : 'generated' });
    try {
      let request = override;
      if (!request) {
        if (fromStory) await abortableDelay(80, token.signal);
        if (!current()) return;
        const canvas = document.querySelector('[data-testid="scene-canvas"]'); if (!canvas) throw new Error('请先等待角色画面加载。');
        const image = new Image(); image.src = canvas.__capture?.() || canvas.toDataURL('image/png'); await image.decode();
        if (!current()) return;
        const surface = document.createElement('canvas'); surface.width = 1280; surface.height = 720;
        const context = surface.getContext('2d'); const scale = Math.max(1280 / image.width, 720 / image.height);
        context.drawImage(image, (1280 - image.width * scale) / 2, (720 - image.height * scale) / 2, image.width * scale, image.height * scale);
        request = { sessionId: b.sessionId.current, turnId: conversation, kind, mode: mediaMode, prompt: `${b.lastUser || '窗边的相遇'}。${lineContext?.text || b.subtitle || b.chapter}。天气：${(lineContext?.scene || b.weather) === 'rain' ? '雨夜' : '雨后的街道'}。`, reference: surface.toDataURL('image/png') };
      }
      lastMediaRequest.current = request;
      request = { ...request, clientJobId: uuid() }; mediaId.current = request.clientJobId;
      const response = await post('/api/media/jobs', request, token.signal); let job = await response.json();
      if (!response.ok) throw new Error(job.error?.message || '创作没有完成。');
      if (!current()) { fetch(`/api/media/jobs/${job.id}`, { method: 'DELETE' }).catch(() => {}); return; }
      mediaId.current = job.id;
      while (current()) {
        setMediaJob(job);
        if (job.status === 'ready') {
          mediaId.current = null;
          if (kind === 'video' && fromStory) {
            while (['speaking', 'thinking'].includes(latest.current.status) && current()) await abortableDelay(150, token.signal);
            if (!current()) return;
          }
          if (kind === 'image') { b.setPhoto(false); setGeneratedImage(job.result); }
          else { b.setPhoto(false); setVideo({ src: job.result.url, poster: job.result.poster, clip: job.result.clip, signal: token.signal, id: job.id }); }
          b.log('media-ready', { kind, source: job.source, cached: job.cached, url: job.result.url }); return;
        }
        if (job.status === 'failed') throw new Error(job.error?.message || '创作没有完成，可以重试。');
        if (job.status === 'cancelled') return;
        await abortableDelay(650, token.signal);
        const response = await fetch(`/api/media/jobs/${job.id}`, { signal: token.signal }); job = await response.json();
        if (!response.ok) throw new Error(job.error?.message || '创作连接中断。');
      }
    } catch (error) { if (current() && error.name !== 'AbortError') { setMediaJob((job) => ({ ...job, status: 'failed', error: { message: error.message } })); b.log('media-error', error.message); } }
  }, [cancelMedia, closeVideo, mediaMode]);

  return { streaming, setConnection, stopAutomatic, onInterrupt, onNewTurn, onStreamLine, onReply, onLineStart, onLineEnd, waitForVideo, onTurnComplete, onReset, public: {
    streaming, setStreaming, cinematics, setCinematics, video, closeVideo, voiceDucked, onVideoState: (state) => { videoNarration.current.speaking = state === 'playing'; latest.current.log('video-state', state); }, onVideoCue: (cue) => { if (typeof cue.text === 'string') videoNarration.current.text = cue.text; latest.current.log('video-cue', cue); if (cue.effect && !cue.seek) latest.current.setEffect({ kind: cue.effect, id: `video-${Date.now()}` }); }, generatedImage, closeGeneratedImage: () => setGeneratedImage(null), journal, connection, hasResume, resume, replayActive, replaySession, importSession, exportSession: snapshot, automaticEnabled, automaticState, toggleAutomatic, mediaCapabilities, mediaMode, setMediaMode, automaticMedia, setAutomaticMedia, mediaJob, startMedia, cancelMedia, retryMedia: () => lastMediaRequest.current && startMedia(lastMediaRequest.current.kind, lastMediaRequest.current),
  } };
}
