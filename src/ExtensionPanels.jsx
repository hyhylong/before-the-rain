import React, { useEffect, useRef, useState } from 'react';
import { Activity, Camera, Check, Download, Film, LoaderCircle, Play, RotateCcw, Square, Upload, X } from 'lucide-react';
import './extensions.css';

function Tool({ label, children, ...props }) {
  return <button type="button" className="icon-button" aria-label={label} title={label} {...props}>{children}<span className="tooltip">{label}</span></button>;
}

export function CreativeTools({ exp, ready }) {
  const busy = ['queued', 'generating'].includes(exp.mediaJob?.status);
  return <>
    <nav className="creative-tools" aria-label="此刻的影像">
      <Tool label={exp.mediaMode === 'live' ? '创作剧情图片' : '拍下此刻'} disabled={!ready || busy || (exp.mediaMode === 'live' && !exp.mediaCapabilities.imageAvailable)} onClick={() => exp.startMedia('image')}><Camera size={18} /></Tool>
      <Tool label={exp.mediaMode === 'live' ? '创作剧情视频' : '播放剧情片段'} disabled={!ready || busy || (exp.mediaMode === 'live' && !exp.mediaCapabilities.videoAvailable)} onClick={() => exp.startMedia('video')}><Film size={18} /></Tool>
      {exp.hasResume && <button className="resume-command" onClick={exp.resume}><Play size={13} />继续上次</button>}
    </nav>
    {exp.mediaJob && exp.mediaJob.status !== 'ready' && <div className="media-job" role="status" aria-live="polite" data-testid="media-job">
      <div className="media-job-heading">{busy ? <LoaderCircle size={16} className="spin" /> : <Camera size={16} />}<span>{exp.mediaJob.status === 'failed' ? '影像暂未完成' : exp.mediaJob.source === 'generated' ? '正在创作' : exp.mediaJob.kind === 'image' ? '正在保存这一刻' : '正在准备片段'}</span><Tool label={busy ? '取消影像任务' : '关闭影像提示'} onClick={exp.cancelMedia}>{busy ? <Square size={12} /> : <X size={14} />}</Tool></div>
      {busy ? <progress value={exp.mediaJob.progress} max="100" aria-label="影像进度" /> : <><p>{exp.mediaJob.error?.message}</p><button className="text-command" onClick={exp.retryMedia}><RotateCcw size={13} />再试一次</button></>}
    </div>}
  </>;
}

export function ExtensionSettings({ exp }) {
  const autoNames = { off: '自然语音', starting: '正在连接麦克风', ready: '自然语音 · 倾听中', candidate: '自然语音 · 听到了', listening: '自然语音 · 正在听' };
  return <>
    <div className="setting-section">
      <label className="setting-row"><span>{autoNames[exp.automaticState] || '自然语音'}</span><input aria-label="自然语音" type="checkbox" className="switch" checked={exp.automaticEnabled} onChange={(event) => exp.toggleAutomatic(event.target.checked)} /></label>
      <label className="setting-row"><span>逐句回应</span><input type="checkbox" className="switch" checked={exp.streaming} onChange={(event) => exp.setStreaming(event.target.checked)} /></label>
      <label className="setting-row"><span>剧情演出</span><input type="checkbox" className="switch" checked={exp.cinematics} onChange={(event) => exp.setCinematics(event.target.checked)} /></label>
    </div>
    <div className="setting-section"><span className="setting-label">影像</span><div className="segmented" aria-label="影像来源"><button aria-pressed={exp.mediaMode === 'mock'} onClick={() => exp.setMediaMode('mock')}>场景留影 / 回放</button><button aria-pressed={exp.mediaMode === 'live'} disabled={!exp.mediaCapabilities.imageAvailable && !exp.mediaCapabilities.videoAvailable} title="需要已连接的创作服务" onClick={() => exp.setMediaMode('live')}>AI 创作</button></div>{exp.mediaMode === 'live' && <label className="setting-row story-generation"><span>剧情节点创作</span><input type="checkbox" className="switch" checked={exp.automaticMedia} onChange={(event) => exp.setAutomaticMedia(event.target.checked)} /></label>}</div>
  </>;
}

const ms = (value) => Number.isFinite(value) ? `${Math.round(value)} ms` : '暂无';
function Diagnostics({ exp }) {
  const [data, setData] = useState(null);
  const [media, setMedia] = useState(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    const refresh = async () => {
      try {
        const [metrics, capabilities] = await Promise.all([fetch('/api/metrics', { signal: controller.signal }), fetch('/api/media/capabilities', { signal: controller.signal })]);
        if (!metrics.ok || !capabilities.ok) throw new Error();
        setData(await metrics.json()); setMedia(await capabilities.json()); setError(false);
      } catch (err) { if (err.name !== 'AbortError') setError(true); }
    };
    void refresh(); const timer = setInterval(refresh, 2500);
    return () => { clearInterval(timer); controller.abort(); };
  }, []);
  if (!data) return <p className="empty-state" role="status">{error ? '暂时无法读取诊断数据。' : '正在读取…'}</p>;
  return <div className="diagnostics" data-testid="diagnostics">
    {error && <p role="alert">连接中断，显示上次数据。</p>}
    <dl className="metric-grid">
      <div><dt>当前音频首包</dt><dd>{ms(exp.timing?.firstAudioMs)}</dd></div><div><dt>当前回应</dt><dd>{ms(exp.latency)}</dd></div>
      <div><dt>首句 P50</dt><dd>{ms(data.latency.firstLineP50)}</dd></div><div><dt>音频首包 P50</dt><dd>{ms(data.latency.firstAudioP50)}</dd></div>
      <div><dt>请求 P50 / P95</dt><dd>{ms(data.latency.p50)} / {ms(data.latency.p95)}</dd></div><div><dt>请求 / 错误 / 取消</dt><dd>{data.requests} / {data.errors} / {data.cancelled}</dd></div>
      <div><dt>文本 / 语音调用</dt><dd>{data.modelCalls} / {data.speechCalls}</dd></div><div><dt>Token 输入 / 输出</dt><dd>{data.tokens.input} / {data.tokens.output}</dd></div>
      <div><dt>影像生成 / 缓存命中</dt><dd>{media?.counts.generated || 0} / {media?.counts.cacheHits || 0}</dd></div><div><dt>文本模型</dt><dd>{data.providers.text.configured ? data.providers.text.model : '本地剧情'}</dd></div>
    </dl>
    <div className="request-log" aria-label="最近请求">{data.recent.filter((item) => !['/api/metrics', '/api/media/capabilities'].includes(item.path)).slice(0, 12).map((item) => <div key={item.requestId}><code>{item.path}</code><span>{item.code || item.status}</span><time>{ms(item.durationMs)}</time></div>)}</div>
  </div>;
}

export function SessionDetails({ exp }) {
  const [tab, setTab] = useState('journal');
  const [importError, setImportError] = useState('');
  const picker = useRef(null);
  const download = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(exp.exportSession(), null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'before-the-rain-session.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const load = async (event) => {
    const file = event.target.files?.[0]; if (!file) return;
    try { if (file.size > 2 * 1024 * 1024) throw new Error(); await exp.importSession(await file.text()); setImportError(''); }
    catch { setImportError('无法读取这份会话，请选择有效的会话记录。'); }
    event.target.value = '';
  };
  return <>
    <div className="detail-tabs" role="tablist" aria-label="会话详情"><button id="journal-tab" aria-controls="journal-panel" role="tab" aria-selected={tab === 'journal'} onClick={() => setTab('journal')}>片段</button><button id="events-tab" aria-controls="events-panel" role="tab" aria-selected={tab === 'events'} onClick={() => setTab('events')}>事件</button><button id="metrics-tab" aria-controls="metrics-panel" role="tab" aria-selected={tab === 'metrics'} onClick={() => setTab('metrics')}><Activity size={13} />诊断</button></div>
    <div role="tabpanel" id={`${tab}-panel`} aria-labelledby={`${tab}-tab`}>
      {tab === 'journal' && <><div className="journal-toolbar"><span>{exp.journal.length} 次交流</span><button className="text-command" disabled={!exp.journal.some((item) => item.played.length)} onClick={() => exp.replayActive ? exp.interrupt('replay-stop') : exp.replaySession()}>{exp.replayActive ? <Square size={12} /> : <Play size={13} />}{exp.replayActive ? '停止回放' : '完整回放'}</button></div><ol className="journal-list">{exp.journal.length ? exp.journal.map((item) => <li key={item.id}><div><span>{item.chapter || '未说完的话'}</span><p>{item.user}</p><small>{item.played.filter((line) => line.complete).length} / {item.lines.length} 句<Check size={10} /></small></div><Tool label={`回放：${item.user}`} disabled={!item.played.length} onClick={() => exp.replaySession(item.id)}><Play size={14} /></Tool></li>) : <li className="empty-state">相遇才刚刚开始。</li>}</ol></>}
      {tab === 'events' && <div className="event-log" aria-label="会话事件">{exp.events.length ? exp.events.slice(-40).reverse().map((event, i) => <div key={`${event.time}-${i}`}><time>{new Date(event.time).toLocaleTimeString('zh-CN', { hour12: false })}</time><span>{event.kind}</span></div>) : <p>相遇才刚刚开始。</p>}</div>}
      {tab === 'metrics' && <Diagnostics exp={exp} />}
    </div>
    {importError && <p className="import-error" role="alert">{importError}</p>}
    <div className="session-files"><button onClick={download}><Download size={15} />导出会话</button><button onClick={() => picker.current.click()}><Upload size={15} />导入会话</button><input ref={picker} type="file" accept="application/json,.json" aria-label="导入会话文件" onChange={load} hidden /></div>
  </>;
}
