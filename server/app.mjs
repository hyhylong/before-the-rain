import express from 'express';
import multer from 'multer';
import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';
import { applyDirectives, initialState, modelReplySchema, SceneError, sessionIdSchema, turnRequestSchema } from './protocol.mjs';
import { createMockReply } from './story.mjs';
import { createLiveReply, createLiveReplyStream, openSpeechStream, synthesize, transcribe } from './providers.mjs';
import { SessionStore } from './session-store.mjs';
import { createMetrics } from './metrics.mjs';
import { createMediaRouter } from './media.mjs';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024, files: 1 } });
const acknowledgementSchema = z.object({ sessionId: sessionIdSchema, turnId: z.number().int().nonnegative(), lineIndex: z.number().int().min(0).max(4) }).strict();
const textSchema = z.object({ text: z.string().trim().min(1).max(1000) }).strict();

function publicError(error) {
  if (error instanceof z.ZodError) return { status: 400, error: { code: 'INVALID_REQUEST', message: '输入格式不正确，请检查内容后重试。', retryable: false } };
  if (error instanceof multer.MulterError) return { status: 400, error: { code: 'INVALID_UPLOAD', message: '录音过大或上传格式错误，请缩短录音。', retryable: false } };
  if (error.type === 'entity.parse.failed' || error.type === 'entity.too.large') return { status: error.status || 400, error: { code: 'INVALID_REQUEST', message: '输入格式不正确或内容过长。', retryable: false } };
  const known = error instanceof SceneError;
  return { status: known ? error.status : 500, error: { code: known ? error.code : 'INTERNAL_ERROR', message: known ? error.message : '服务暂时无法响应，请稍后重试。', retryable: known ? error.retryable : true } };
}

export function createApp(options = {}) {
  const env = options.env || process.env;
  const fetcher = options.fetcher || fetch;
  const mockDelayMs = options.mockDelayMs ?? 680;
  const sessions = new SessionStore(options.dataDir ?? false);
  const metrics = createMetrics(env);
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '6mb' }));
  app.use('/api', metrics.middleware, (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

  function pruneSessions() {
    const cutoff = Date.now() - 60 * 60 * 1000;
    for (const [id, session] of sessions) {
      if (session.updatedAt < cutoff) { session.controller?.abort(); sessions.delete(id); }
    }
  }

  function beginTurn(request, res) {
    pruneSessions();
    let session = sessions.get(request.sessionId);
    if (!session) {
      if (sessions.size >= 500) throw new SceneError('SESSION_LIMIT', '当前体验人数较多，请稍后再试。', 503, true);
      session = { state: initialState(), history: [], lastTurnId: -1, updatedAt: Date.now(), controller: null, latestReply: null, pending: null };
      sessions.set(request.sessionId, session);
    }
    if (request.turnId <= session.lastTurnId) throw new SceneError('STALE_TURN', '这一轮交流已失效，请发送新的内容。', 409, true);
    session.controller?.abort();
    const controller = new AbortController();
    session.controller = controller;
    session.pending = null;
    session.lastTurnId = request.turnId;
    session.updatedAt = Date.now();
    sessions.save(request.sessionId);
    const turn = { request, session, controller, timedOut: false, start: performance.now() };
    turn.timeout = setTimeout(() => { turn.timedOut = true; controller.abort(); }, Number(env.SCENE_TIMEOUT_MS) || 20000);
    turn.onClose = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', turn.onClose);
    res.locals.mode = request.mode;
    res.locals.turnId = request.turnId;
    return turn;
  }

  function checkTurn(turn) {
    if (turn.timedOut) throw new SceneError('MODEL_TIMEOUT', '等待回复超时，请重试或切换演示模式。', 504, true);
    if (turn.controller.signal.aborted || turn.session.controller !== turn.controller || turn.session.lastTurnId !== turn.request.turnId) throw new SceneError('TURN_CANCELLED', '这一轮交流已被新的输入打断。', 409, true);
  }

  function finishTurn(turn, res) {
    if (!turn) return;
    clearTimeout(turn.timeout);
    res.removeListener('close', turn.onClose);
    if (turn.session.controller === turn.controller) turn.session.controller = null;
  }

  async function mockReply(turn) {
    const { request, session, controller } = turn;
    if (request.fault === 'network') throw new SceneError('DEMO_CONNECTION_LOST', '连接暂时中断。你的交流还在，可以重试。', 503, true);
    if (request.fault === 'timeout') {
      await delay(options.faultDelayMs ?? 2000, null, { signal: controller.signal });
      throw new SceneError('DEMO_TIMEOUT', 'Mira 暂时没有回应。请重试，或换一句话。', 504, true);
    }
    await delay(mockDelayMs, null, { signal: controller.signal });
    return modelReplySchema.parse(createMockReply(request.message, session.state));
  }

  function providerOptions(turn) {
    if (turn.request.fault !== 'none') throw new SceneError('INVALID_FAULT_MODE', '故障演练仅在演示模式下可用。', 400);
    return { message: turn.request.message, state: turn.session.state, history: turn.session.history, signal: turn.controller.signal, env, fetcher, onModelCall: metrics.modelCall, onUsage: metrics.usage };
  }

  function normalizeTurnError(error, turn) {
    if (turn?.timedOut) return new SceneError('MODEL_TIMEOUT', '等待回复超时，请重试或切换演示模式。', 504, true);
    if (error.name === 'AbortError' && turn?.controller.signal.aborted) return new SceneError('TURN_CANCELLED', '这一轮交流已被新的输入打断。', 409, true);
    return error;
  }

  function applyAcknowledged(session) {
    const pending = session.pending;
    if (!pending || pending.ackIndex < 0) return;
    const partial = { ...pending.reply, lines: pending.reply.lines.slice(0, pending.ackIndex + 1) };
    session.state = applyDirectives(pending.baseState, partial);
    session.history = [...pending.baseHistory, { role: 'user', content: pending.message }, { role: 'assistant', content: JSON.stringify(partial) }].slice(-12);
    if (session.latestReply) session.latestReply = { ...session.latestReply, state: session.state, acknowledgedLine: pending.ackIndex };
  }

  app.get('/api/health', (_req, res) => res.json({ ok: true, liveAvailable: Boolean(env.SCENE_API_KEY), sttAvailable: Boolean(env.SCENE_VOICE_API_KEY), ttsAvailable: Boolean(env.SCENE_VOICE_API_KEY) }));
  app.get('/api/capabilities', (_req, res) => res.json({ streamingText: true, streamingAudio: true, acknowledgedCues: true, persistentSessions: Boolean(sessions.directory), sessionTtlMs: 3600000 }));
  app.get('/api/metrics', (_req, res) => res.json(metrics.snapshot()));

  app.post('/api/turn', async (req, res, next) => {
    let turn;
    try {
      const request = turnRequestSchema.parse(req.body);
      turn = beginTurn(request, res);
      const result = request.mode === 'mock' ? await mockReply(turn) : await createLiveReply(providerOptions(turn));
      checkTurn(turn);
      const { session } = turn;
      session.state = applyDirectives(session.state, result);
      session.history = [...session.history, { role: 'user', content: request.message }, { role: 'assistant', content: JSON.stringify(result) }].slice(-12);
      const reply = { ...result, turnId: request.turnId, replyId: randomUUID(), state: session.state, acknowledgedLine: result.lines.length - 1, complete: true };
      session.latestReply = reply;
      sessions.save(request.sessionId);
      res.json(reply);
    } catch (error) { next(normalizeTurnError(error, turn)); }
    finally { finishTurn(turn, res); }
  });

  app.post('/api/turn/stream', async (req, res, next) => {
    let turn;
    try {
      const request = turnRequestSchema.parse(req.body);
      turn = beginTurn(request, res);
      const { session } = turn;
      const replyId = randomUUID();
      const pending = { turnId: request.turnId, replyId, message: request.message, baseState: { ...session.state }, baseHistory: [...session.history], reply: { lines: [], choices: [], chapter: '' }, ackIndex: -1, complete: false };
      session.pending = pending;
      const emit = (event) => { if (!res.destroyed) res.write(`${JSON.stringify({ ...event, turnId: request.turnId })}\n`); };
      const line = (value, index) => {
        checkTurn(turn);
        pending.reply.lines.push(value);
        session.latestReply = { ...pending.reply, turnId: request.turnId, replyId, acknowledgedLine: pending.ackIndex, complete: false, state: session.state };
        sessions.save(request.sessionId);
        if (index === 0) res.locals.firstLineMs = Math.round(performance.now() - turn.start);
        emit({ type: 'line', replyId, index, line: value });
      };
      res.type('application/x-ndjson');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();
      let result;
      if (request.mode === 'mock') {
        result = await mockReply(turn);
        for (const [index, value] of result.lines.entries()) {
          if (index) await delay(options.streamDelayMs ?? 70, null, { signal: turn.controller.signal });
          line(value, index);
        }
      } else {
        for await (const event of createLiveReplyStream(providerOptions(turn))) {
          if (event.type === 'line') line(event.line, event.index);
          if (event.type === 'final') result = event.reply;
        }
      }
      checkTurn(turn);
      if (!result) throw new SceneError('INVALID_MODEL_REPLY', '流式回复没有完整结束，请重试。', 502, true);
      pending.reply = result;
      pending.complete = true;
      session.latestReply = { ...result, turnId: request.turnId, replyId, state: session.state, acknowledgedLine: pending.ackIndex, complete: true };
      applyAcknowledged(session);
      sessions.save(request.sessionId);
      emit({ type: 'final', ...session.latestReply, timing: { firstLineMs: res.locals.firstLineMs, totalMs: Math.round(performance.now() - turn.start) } });
      res.end();
    } catch (error) {
      const normalized = normalizeTurnError(error, turn);
      if (!res.headersSent) return next(normalized);
      const safe = publicError(normalized);
      res.locals.errorCode = safe.error.code;
      if (!res.destroyed) { res.write(`${JSON.stringify({ type: 'error', turnId: turn?.request.turnId, error: safe.error })}\n`); res.end(); }
    } finally { finishTurn(turn, res); }
  });

  app.get('/api/session/:id', (req, res, next) => {
    try {
      const id = sessionIdSchema.parse(req.params.id);
      pruneSessions();
      const session = sessions.get(id);
      if (!session) throw new SceneError('SESSION_NOT_FOUND', '这次相遇尚未保存，可以重新开始。', 404, true);
      res.json({ sessionId: id, state: session.state, lastTurnId: session.lastTurnId, latestReply: session.latestReply || null, history: session.history, updatedAt: session.updatedAt, acknowledgedLine: session.pending?.ackIndex ?? session.latestReply?.acknowledgedLine ?? -1 });
    } catch (error) { next(error); }
  });

  app.post('/api/session/ack', (req, res, next) => {
    try {
      const { sessionId, turnId, lineIndex } = acknowledgementSchema.parse(req.body);
      const session = sessions.get(sessionId);
      if (!session || session.lastTurnId !== turnId || session.pending?.turnId !== turnId) throw new SceneError('STALE_TURN', '这一轮播放确认已失效。', 409, true);
      const pending = session.pending;
      if (lineIndex >= pending.reply.lines.length || lineIndex > pending.ackIndex + 1) throw new SceneError('INVALID_CUE_ACK', '播放确认顺序不正确。', 409, true);
      if (lineIndex > pending.ackIndex) {
        pending.ackIndex = lineIndex;
        session.updatedAt = Date.now();
        applyAcknowledged(session);
        sessions.save(sessionId);
      }
      res.json({ ok: true, acknowledgedLine: pending.ackIndex, state: session.state });
    } catch (error) { next(error); }
  });

  app.post('/api/session/reset', (req, res, next) => {
    try {
      const { sessionId } = z.object({ sessionId: sessionIdSchema }).strict().parse(req.body);
      sessions.get(sessionId)?.controller?.abort();
      sessions.delete(sessionId);
      res.json({ ok: true, state: initialState() });
    } catch (error) { next(error); }
  });

  app.post('/api/stt', upload.single('audio'), async (req, res, next) => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    const onClose = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', onClose);
    try {
      if (!req.file) throw new SceneError('AUDIO_REQUIRED', '请提供一段录音。', 400);
      if (!/^(audio\/(webm|ogg|wav|mpeg|mp4|x-wav)|video\/webm)(;.*)?$/.test(req.file.mimetype)) throw new SceneError('INVALID_AUDIO', '不支持这种录音格式。', 400);
      if (env.SCENE_VOICE_API_KEY) metrics.speechCall();
      res.json(await transcribe({ file: req.file, signal: controller.signal, env, fetcher }));
    } catch (error) { next(error.name === 'AbortError' ? new SceneError('STT_TIMEOUT', '语音识别超时，请重新录音或使用文字。', 504, true) : error); }
    finally { clearTimeout(timeout); res.removeListener('close', onClose); }
  });

  function speechRoute(streaming) {
    return async (req, res, next) => {
      const start = performance.now();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20000);
      const onClose = () => { if (!res.writableEnded) controller.abort(); };
      res.on('close', onClose);
      try {
        const { text } = textSchema.parse(req.body);
        if (env.SCENE_VOICE_API_KEY) metrics.speechCall();
        if (streaming) {
          const upstream = await openSpeechStream({ text, signal: controller.signal, env, fetcher });
          res.type('audio/mpeg');
          res.setHeader('X-Accel-Buffering', 'no');
          async function* audioChunks() {
            let first = true;
            for await (const chunk of upstream.body) {
              if (controller.signal.aborted) throw new DOMException('Aborted', 'AbortError');
              if (first) {
                first = false;
                res.locals.firstAudioMs = Math.round(performance.now() - start);
                res.setHeader('X-Audio-First-Byte-Ms', String(res.locals.firstAudioMs));
              }
              yield chunk;
            }
          }
          await pipeline(Readable.from(audioChunks()), res, { signal: controller.signal });
        } else res.type('audio/mpeg').send(await synthesize({ text, signal: controller.signal, env, fetcher }));
      } catch (error) {
        if (!res.headersSent) next(error.name === 'AbortError' ? new SceneError('TTS_TIMEOUT', '语音加载超时，将继续显示字幕。', 504, true) : error);
        else if (!res.destroyed) res.destroy();
      } finally { clearTimeout(timeout); res.removeListener('close', onClose); }
    };
  }
  app.post('/api/tts', speechRoute(false));
  app.post('/api/tts/stream', speechRoute(true));

  app.use('/api', options.mediaRouter || createMediaRouter({ env, fetcher, dataDir: options.dataDir ? path.join(options.dataDir, 'media') : false }));
  app.use('/api', (_req, _res, next) => next(new SceneError('NOT_FOUND', '没有找到这个接口。', 404)));
  app.use((error, _req, res, next) => {
    if (res.headersSent) return next(error);
    if (res.destroyed) return;
    const safe = publicError(error);
    res.locals.errorCode = safe.error.code;
    res.status(safe.status).json({ error: safe.error });
  });
  return app;
}
