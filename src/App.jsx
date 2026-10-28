import React, { useEffect, useRef, useState } from 'react';
import { ArrowUp, ArrowUpRight, AudioLines, Check, ChevronRight, CloudRain, Coffee, Download, Headphones, Info, LoaderCircle, Mic, Moon, Pause, Play, RotateCcw, Settings2, Square, Star, Sun, Volume2, VolumeX, X } from 'lucide-react';
import MiraScene from './scene/MiraScene.jsx';
import useExperience from './useExperience.jsx';
import { createRainSound } from './speech.mjs';
import VideoStage, { preloadStoryVideos } from './media/VideoStage.jsx';
import { CreativeTools, ExtensionSettings, SessionDetails } from './ExtensionPanels.jsx';

const stateNames = { idle: '在你身边', listening: '正在倾听', thinking: '想了想', speaking: '轻声说着' };
const emotions = { curious: '好奇', guarded: '犹豫', warm: '温柔', melancholy: '想念' };

function IconButton({ label, children, className = '', ...props }) {
  return <button type="button" className={`icon-button ${className}`} aria-label={label} title={label} {...props}>{children}<span className="tooltip" role="tooltip">{label}</span></button>;
}

function Dialog({ title, onClose, children, className = '', modal = true }) {
  const ref = useRef(null);
  useEffect(() => {
    const dialog = ref.current;
    if (modal) dialog.showModal(); else dialog.show();
    const onClick = (event) => { if (event.target === dialog) { const box = dialog.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) onClose(); } };
    dialog.addEventListener('click', onClick);
    return () => dialog.removeEventListener('click', onClick);
  }, [onClose, modal]);
  return <dialog ref={ref} className={`dialog ${className}`} onCancel={(event) => { event.preventDefault(); onClose(); }} aria-label={title} aria-modal={modal}>
    <header className="dialog-header"><h2>{title}</h2><IconButton label="关闭" onClick={onClose}><X size={19} /></IconButton></header>{children}
  </dialog>;
}

export default function App() {
  const exp = useExperience();
  const [settings, setSettings] = useState(false);
  const [details, setDetails] = useState(false);
  const [sceneReady, setSceneReady] = useState(false);
  const [sceneError, setSceneError] = useState(false);
  const [rainSound, setRainSound] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const [reducedMotion, setReducedMotion] = useState(() => matchMedia('(prefers-reduced-motion: reduce)').matches);
  const rainRef = useRef(null);
  const inputRef = useRef(null);
  const active = exp.status === 'speaking' || exp.status === 'thinking';

  useEffect(() => { preloadStoryVideos(); }, []);

  useEffect(() => {
    if (rainSound && exp.weather === 'rain') {
      try { rainRef.current = createRainSound(); } catch { setRainSound(false); }
    }
    return () => { rainRef.current?.stop(); rainRef.current = null; };
  }, [rainSound, exp.weather]);

  return <main className={`experience status-${exp.status} weather-${exp.weather}`} data-testid="experience" data-status={exp.status} data-weather={exp.weather} data-emotion={exp.emotion}>
    <div className="scene-layer">
      <MiraScene status={exp.status} emotion={exp.emotion} gesture={exp.gesture} weather={exp.weather} effect={exp.effect?.kind || null} speakingLevel={exp.speakingLevel} viseme={exp.viseme} reducedMotion={reducedMotion} onReady={() => setSceneReady(true)} onError={() => { setSceneReady(true); setSceneError(true); }} />
      {sceneError && <div className="scene-fallback"><img src="/images/lighthouse.png" alt="Mira 收藏的海边灯塔" /><p>画面暂时无法加载，Mira 依然听得到你。</p></div>}
      <div className="scene-vignette" />
    </div>

    <header className="topbar">
      <a className="brand" href="/" aria-label="雨停之前 首页"><span className="brand-icon"><Coffee size={21} strokeWidth={1.5} /></span><span className="brand-copy"><strong>雨停之前</strong><span>BEFORE THE RAIN</span></span></a>
      <div className="top-actions"><span className={`mode-badge ${exp.mode === 'live' ? 'is-live' : ''}`}><span />{exp.mode === 'mock' ? '演示模式' : '实时连接'}</span>
        <IconButton label={rainSound ? '关闭环境音' : '开启环境音'} aria-pressed={rainSound} onClick={() => setRainSound((value) => !value)} className={rainSound ? 'is-active' : ''}><Headphones size={19} /></IconButton>
        <IconButton label="设置" onClick={() => setSettings(true)}><Settings2 size={19} /></IconButton>
      </div>
    </header>
    <CreativeTools exp={exp} ready={sceneReady && !sceneError} />
    {exp.video && <VideoStage key={exp.video.id} {...exp.video} onClose={exp.closeVideo} reducedMotion={reducedMotion} initialMuted={false} muteAll={exp.muted} volume={exp.volume / 100 * (exp.voiceDucked ? 0.15 : 1)} onState={exp.onVideoState} onCue={exp.onVideoCue} onError={() => exp.setNotice('片段暂时无法播放，原来的场景仍在。')} />}

    <aside className="scene-caption" aria-label="场景信息"><div className="scene-coordinate"><span className="tiny-line" />一个雨夜，一次偶遇</div><h1>今晚，<br />再坐一会儿。</h1><p>城南 · 最后一间咖啡馆</p><div className="weather-label">{exp.weather === 'rain' ? <CloudRain size={16} /> : <Sun size={16} />}<span>{exp.weather === 'rain' ? '23:47 / 雨还在下' : '00:08 / 雨停了'}</span></div></aside>

    <div className="chapter-marker"><span>01</span><span className="chapter-line" /><span>{exp.chapter}</span><Star size={11} fill="currentColor" /></div>

    {!sceneReady && <div className="scene-loading" role="status"><LoaderCircle className="spin" size={22} /><span>咖啡馆的灯亮着</span></div>}

    <section className="conversation" aria-label="与 Mira 的对话">
      <div className="character-meta"><span className="character-name">Mira<span>米拉</span></span><span className="meta-divider" /><span className={`character-state ${exp.status}`}><span className="state-indicator">{exp.status === 'speaking' || exp.status === 'listening' ? <AudioLines size={14} /> : exp.status === 'thinking' ? <LoaderCircle size={13} className="spin" /> : <span className="presence-dot" />}</span><span data-testid="character-status">{stateNames[exp.status]}</span></span><span className="emotion-label">{emotions[exp.emotion]}</span></div>

      <div className="subtitle-frame">
        {exp.error ? <div className="error-state" role="alert"><span>{exp.error}</span><button className="retry-button" onClick={exp.retry}><RotateCcw size={14} />再试一次</button></div>
          : exp.status === 'listening' ? <div className="listening-caption"><span className="voice-wave">{Array.from({ length: 15 }, (_, i) => <i key={i} style={{ '--i': i }} />)}</span><p>{exp.input || '嗯，我听着。'}</p></div>
            : exp.status === 'thinking' ? <div className="thinking-caption"><span /> <span /> <span /></div>
              : <p className="subtitle" data-testid="subtitle" aria-live="polite" aria-atomic="true">{exp.subtitle.slice(0, exp.visibleChars)}<span className="subtitle-unread" aria-hidden="true">{exp.subtitle.slice(exp.visibleChars)}</span></p>}
        {exp.subtitle && exp.status === 'idle' && !exp.error && <IconButton label="重听这段话" className="replay-button" onClick={exp.replay}><Play size={14} fill="currentColor" /></IconButton>}
      </div>

      <div className="suggestions" aria-label="可以回应"><span className="suggestion-label">{exp.lastUser ? '接着聊' : '打个招呼'}</span>{exp.choices.map((choice, index) => <button type="button" key={choice} onClick={() => exp.send(choice)} data-testid={`choice-${index}`}><span>{choice}</span><ArrowUpRight size={13} /></button>)}</div>

      {exp.notice && <div className="notice" role="status"><Info size={14} /><span>{exp.notice}</span><button aria-label="关闭提示" onClick={() => exp.setNotice(null)}><X size={13} /></button></div>}

      <form className={`composer ${exp.status === 'listening' ? 'is-listening' : ''}`} onSubmit={(event) => { event.preventDefault(); exp.send(exp.input); }}>
        <IconButton label={exp.muted ? '开启角色语音' : '静音角色语音'} onClick={exp.toggleMute} className="mute-button">{exp.muted ? <VolumeX size={19} /> : <Volume2 size={19} />}</IconButton>
        <input ref={inputRef} aria-label="对 Mira 说点什么" placeholder={exp.status === 'listening' ? '正在聆听你的声音…' : '对 Mira 说点什么…'} value={exp.input} onChange={(event) => exp.setInput(event.target.value)} maxLength={1000} autoComplete="off" enterKeyHint="send" />
        {exp.input.trim() ? <IconButton label="发送" type="submit" className="send-button"><ArrowUp size={20} /></IconButton> : active ? <IconButton label="打断回复" className="stop-button" onClick={() => exp.interrupt('stop-button')}><Square size={14} fill="currentColor" /></IconButton> : null}
        <span className="composer-divider" />
        <IconButton label={exp.status === 'listening' ? '结束语音输入' : active ? '打断并开始语音' : '开始语音输入'} onClick={exp.startMic} className={`mic-button ${exp.status === 'listening' ? 'recording' : ''}`}>{exp.status === 'listening' ? <Square size={16} fill="currentColor" /> : <Mic size={21} />}</IconButton>
      </form>
      <footer className="conversation-footer"><span className="connection-label" data-connection={exp.connection} title={{ online: '已连接', offline: '连接中断', connecting: '正在连接', reconnecting: '正在重连' }[exp.connection]}>{exp.replayActive ? '重温这次相遇' : exp.automaticEnabled ? 'Mira 正在听你说' : exp.mode === 'mock' ? '一段属于你的雨夜' : '与 Mira 实时相遇'}</span><button onClick={() => setDetails(true)} aria-label="查看会话详情">{exp.latency !== null && <span>{exp.latency} ms</span>}<Info size={13} /></button></footer>
    </section>

    <div className="scene-side-note"><span>STAY A LITTLE LONGER</span><span className="side-line" /></div>

    {settings && <Dialog title="此刻的设置" onClose={() => setSettings(false)}>
      <div className="setting-section"><span className="setting-label">会话</span><div className="segmented" aria-label="会话模式"><button aria-pressed={exp.mode === 'mock'} onClick={() => exp.switchMode('mock')}>演示模式</button><button aria-pressed={exp.mode === 'live'} disabled={!exp.health.liveAvailable} title={!exp.health.liveAvailable ? '尚未连接模型服务' : '连接模型服务'} onClick={() => exp.switchMode('live')}>实时连接{!exp.health.liveAvailable && <span className="unavailable-dot" />}</button></div><div className="setting-status"><span className="presence-dot" />{exp.mode === 'mock' ? '本地故事与中文语音已就绪' : '模型服务已连接'}</div></div>
      <div className="setting-section"><label className="setting-row" htmlFor="volume"><span>角色音量</span><span>{exp.volume}%</span></label><input id="volume" type="range" min="0" max="100" value={exp.volume} onChange={(event) => exp.setVolume(Number(event.target.value))} /></div>
      <ExtensionSettings exp={exp} />
      <div className="setting-section"><label className="setting-row"><span>减少动态效果</span><input type="checkbox" className="switch" checked={reducedMotion} onChange={(event) => setReducedMotion(event.target.checked)} /></label><label className="setting-row"><span>雨声</span><input type="checkbox" className="switch" checked={rainSound} onChange={(event) => setRainSound(event.target.checked)} /></label></div>
      <div className="setting-section"><label className="setting-row" htmlFor="connection"><span>下次连接</span><select id="connection" value={exp.fault} onChange={(event) => exp.setFault(event.target.value)} disabled={exp.mode !== 'mock'}><option value="none">正常</option><option value="network">断线演练</option><option value="timeout">超时演练</option></select></label></div>
      <button className="reset-button" onClick={() => { exp.reset(); setSettings(false); }}><RotateCcw size={16} />重新相遇<ChevronRight size={15} /></button>
      <div className="settings-bottom"><Moon size={13} /><span>雨停之前 · 第一夜</span></div>
    </Dialog>}

    {details && <Dialog title="这一次相遇" onClose={() => setDetails(false)} className="details-dialog"><SessionDetails exp={exp} /></Dialog>}

    {exp.generatedImage && <Dialog title={exp.generatedImage.source === 'generated' ? 'Mira 的新画面' : '这一刻的留影'} onClose={exp.closeGeneratedImage} className="photo-dialog generated-dialog" modal={false}><figure className="memory-photo"><img src={exp.generatedImage.url} alt="Mira 与咖啡馆的当前场景留影" /><figcaption>{exp.generatedImage.source === 'generated' ? 'MIRA · 剧情创作' : 'MIRA · 此时此刻'}</figcaption></figure><a className="photo-continue" href={exp.generatedImage.url} download="mira-scene.png"><Download size={14} />保存画面</a></Dialog>}

    {exp.photo && <Dialog title="Mira 的一张底片" onClose={() => exp.setPhoto(false)} className="photo-dialog" modal={false}><figure className="memory-photo">{imageFailed ? <div className="photo-failed"><CloudRain size={32} /><p>底片暂时没有显影。</p><button onClick={() => setImageFailed(false)}>重新加载</button></div> : <img src="/images/lighthouse.png" alt="粉色晨光下，海岸灯塔亮着微弱的灯，海浪拍打礁石。" onError={() => setImageFailed(true)} />}<figcaption>「有些人不在照片里，却一直在镜头后面。」<span>MIRA · 海边，去年九月</span></figcaption></figure><button className="photo-continue" onClick={() => exp.setPhoto(false)}>把照片还给她<ArrowUpRight size={15} /></button></Dialog>}
  </main>;
}
