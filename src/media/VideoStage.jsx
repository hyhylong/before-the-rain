import React, { useEffect, useRef, useState } from 'react';
import { LoaderCircle, Pause, Play, RotateCcw, Volume2, VolumeX, X } from 'lucide-react';
import { CLIPS, CueTimeline } from './timeline.mjs';
import './media.css';

const warmed = new Map();
let supportsWebm;
function clipSource(entry) {
  supportsWebm ??= Boolean(document.createElement('video').canPlayType('video/webm; codecs="vp9,opus"'));
  return supportsWebm ? entry.src : entry.fallbackSrc || entry.src;
}
export function preloadStoryVideos() {
  for (const entry of Object.values(CLIPS)) {
    const source = clipSource(entry);
    if (warmed.has(source)) continue;
    const video = document.createElement('video');
    video.preload = 'auto'; video.muted = true; video.src = source;
    video.load(); warmed.set(source, video);
  }
}

export default function VideoStage({ clip = null, src, poster, timeline, signal, onClose, onState, onCue, onError, reducedMotion = false, initialMuted = false, muteAll = false, volume = 0.85 }) {
  const definition = CLIPS[clip] || {};
  const source = src || (definition.src ? clipSource(definition) : null);
  const image = poster || definition.poster;
  const cues = timeline || definition.timeline || [];
  const video = useRef(null);
  const overlay = useRef(null);
  const callbacks = useRef({ onClose, onState, onCue, onError });
  callbacks.current = { onClose, onState, onCue, onError };
  const [state, setState] = useState('loading');
  const [muted, setMuted] = useState(initialMuted);
  const [progress, setProgress] = useState(0);
  const [duration, setDuration] = useState(definition.duration || 0);
  const [caption, setCaption] = useState('');
  const [ready, setReady] = useState(false);
  const [retry, setRetry] = useState(0);
  const clock = useRef(null);
  const live = useRef(false);
  const halt = useRef(null);

  useEffect(() => { preloadStoryVideos(); }, []);
  useEffect(() => { if (video.current) video.current.volume = Math.max(0, Math.min(1, Number(volume) || 0)); }, [volume]);

  useEffect(() => {
    if (!source || !video.current) return undefined;
    const element = video.current;
    const schedule = new CueTimeline(cues);
    clock.current = schedule;
    live.current = true;
    let returnTimer;
    let loadTimer;
    let frame;
    let detached = false;
    let broken = false;
    const transition = (next) => {
      if (detached) return;
      setState(next); callbacks.current.onState?.(next);
    };
    const stop = (cancelled) => {
      if (detached) return;
      schedule.cancel();
      element.pause();
      overlay.current?.pause();
      if (cancelled) transition('cancelled');
      detached = true; live.current = false;
      cancelAnimationFrame(frame); clearTimeout(returnTimer); clearTimeout(loadTimer);
    };
    halt.current = stop;
    const abort = () => { stop(true); callbacks.current.onClose?.(); };
    const tick = () => {
      if (detached) return;
      setProgress(element.currentTime || 0);
      for (const cue of !element.paused && element.readyState >= 2 ? schedule.advance(element.currentTime || 0) : []) {
        if (typeof cue.text === 'string') setCaption(cue.text);
        callbacks.current.onCue?.(cue);
      }
      frame = requestAnimationFrame(tick);
    };
    const metadata = () => { if (!detached && Number.isFinite(element.duration)) setDuration(element.duration); };
    const playing = () => { if (!detached && !broken) { clearTimeout(loadTimer); setReady(true); transition('playing'); overlay.current?.play().catch(() => {}); } };
    const waiting = () => { if (!broken && !detached) { transition('loading'); clearTimeout(loadTimer); loadTimer = setTimeout(failed, 12000); } };
    const paused = () => { if (!element.ended && !detached && !broken) { overlay.current?.pause(); transition('paused'); } };
    const ended = () => {
      if (detached) return;
      for (const cue of schedule.advance(element.duration || 0)) {
        if (typeof cue.text === 'string') setCaption(cue.text);
        callbacks.current.onCue?.(cue);
      }
      transition('ended');
      returnTimer = setTimeout(() => { if (!detached) callbacks.current.onClose?.(); }, reducedMotion ? 100 : 700);
    };
    const failed = () => {
      if (detached || broken) return;
      broken = true; clearTimeout(loadTimer); element.pause(); overlay.current?.pause();
      schedule.cancel(); cancelAnimationFrame(frame); element.removeAttribute('src'); element.load();
      transition('failed'); setReady(false); setCaption('');
      callbacks.current.onError?.(new Error('剧情片段加载失败，已保留场景画面。'));
    };
    const handlers = { loadedmetadata: metadata, playing, waiting, pause: paused, ended, error: failed };
    Object.entries(handlers).forEach(([name, handler]) => element.addEventListener(name, handler));
    signal?.addEventListener('abort', abort, { once: true });
    setReady(false); setCaption(''); setProgress(0); transition('loading');
    loadTimer = setTimeout(failed, 12000);
    element.src = source; element.load();
    if (signal?.aborted) abort();
    else {
      element.play().catch((error) => {
        if (error.name === 'NotAllowedError') { clearTimeout(loadTimer); transition('paused'); }
        else failed();
      });
      frame = requestAnimationFrame(tick);
    }
    return () => {
      stop(false);
      signal?.removeEventListener('abort', abort);
      Object.entries(handlers).forEach(([name, handler]) => element.removeEventListener(name, handler));
      element.removeAttribute('src'); element.load();
      if (overlay.current) { overlay.current.pause(); overlay.current.removeAttribute('src'); overlay.current.load(); }
    };
  }, [source, signal, retry, reducedMotion]);

  if (!source) return null;
  const close = () => { halt.current?.(true); callbacks.current.onClose?.(); };
  const seek = (event) => {
    const next = Number(event.target.value);
    if (!video.current || !live.current) return;
    video.current.currentTime = next; setProgress(next);
    if (overlay.current && Number.isFinite(overlay.current.duration) && overlay.current.duration > 0) overlay.current.currentTime = next % overlay.current.duration;
    const current = clock.current.seek(next).at(-1); setCaption(current?.text || '');
    if (current) callbacks.current.onCue?.({ ...current, seek: true });
  };
  return <section className={`video-stage is-${state}`} data-testid="video-stage" data-state={state} aria-label={definition.title || '场景片段'}>
    {image && <img className="video-poster" src={image} alt="" />}
    <video ref={video} playsInline muted={muteAll || muted} preload="auto" className={ready ? 'is-ready' : ''} data-testid="story-video" />
    {clip === 'rain' && <video ref={overlay} className="video-rain-overlay" src="/video/rain-overlay.webm" muted loop autoPlay playsInline aria-hidden="true" style={{ opacity: Math.max(0, 1 - progress / 4) }} />}
    <div className="video-shade" />
    <div className="video-controls">
      <span className="video-title">{definition.title || '新的片刻'}</span>
      <button type="button" aria-label={state === 'playing' ? '暂停剧情' : '播放剧情'} title={state === 'playing' ? '暂停剧情' : '播放剧情'} onClick={() => { if (video.current?.paused) video.current.play().catch(() => {}); else video.current?.pause(); }}>{state === 'playing' ? <Pause size={16} /> : <Play size={16} />}</button>
      <button type="button" aria-label={muteAll ? '角色声音已静音' : muted ? '开启片段声音' : '静音片段'} title={muteAll ? '角色声音已静音' : muted ? '开启片段声音' : '静音片段'} disabled={muteAll} onClick={() => setMuted((value) => !value)}>{muteAll || muted ? <VolumeX size={16} /> : <Volume2 size={16} />}</button>
      <button type="button" aria-label="结束剧情片段" title="结束剧情片段" onClick={close}><X size={17} /></button>
      <input type="range" aria-label="剧情进度" min="0" max={duration || 1} step="0.05" value={Math.min(progress, duration || 1)} onChange={seek} />
    </div>
    {state === 'loading' && <div className="video-status" role="status"><LoaderCircle size={18} className="spin" /><span>那一刻，正在靠近</span></div>}
    {state === 'failed' && <div className="video-status video-error" role="alert"><span>这一段记忆暂时没有显影。</span><div><button onClick={() => setRetry((value) => value + 1)}><RotateCcw size={14} />重试</button><button onClick={close}>回到咖啡馆</button></div></div>}
    {caption && <p className="video-caption" aria-live="polite">{caption}</p>}
  </section>;
}
