import { randomUUID } from 'node:crypto';

export function createMetrics(env) {
  const state = { startedAt: new Date().toISOString(), requests: 0, errors: 0, cancelled: 0, modelCalls: 0, speechCalls: 0, inputTokens: 0, outputTokens: 0, recent: [], durations: [], firstLines: [], firstAudio: [] };
  const percentile = (values, fraction) => {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))]);
  };
  const middleware = (req, res, next) => {
    const start = performance.now();
    const requestPath = `${req.baseUrl}${req.path}`;
    const id = randomUUID();
    state.requests += 1;
    res.setHeader('X-Request-Id', id);
    res.locals.requestId = id;
    let recorded = false;
    const finish = () => {
      if (recorded) return;
      recorded = true;
      const durationMs = Math.round(performance.now() - start);
      const cancelled = !res.writableEnded || res.locals.errorCode === 'TURN_CANCELLED';
      const failed = res.statusCode >= 400 || Boolean(res.locals.errorCode);
      if (failed) state.errors += 1;
      if (cancelled) state.cancelled += 1;
      state.durations.push(durationMs);
      state.durations = state.durations.slice(-300);
      if (Number.isFinite(res.locals.firstLineMs)) {
        state.firstLines.push(res.locals.firstLineMs);
        state.firstLines = state.firstLines.slice(-300);
      }
      if (Number.isFinite(res.locals.firstAudioMs)) {
        state.firstAudio.push(res.locals.firstAudioMs);
        state.firstAudio = state.firstAudio.slice(-300);
      }
      state.recent.push({ requestId: id, time: new Date().toISOString(), path: requestPath, status: res.statusCode, durationMs, cancelled, code: res.locals.errorCode || null, firstLineMs: res.locals.firstLineMs ?? null, firstAudioMs: res.locals.firstAudioMs ?? null, mode: res.locals.mode || null, turnId: res.locals.turnId ?? null });
      state.recent = state.recent.slice(-100);
    };
    res.once('finish', finish);
    res.once('close', finish);
    next();
  };
  return {
    middleware,
    modelCall: () => { state.modelCalls += 1; },
    speechCall: () => { state.speechCalls += 1; },
    usage: (usage) => {
      if (Number.isFinite(usage?.prompt_tokens) && usage.prompt_tokens >= 0) state.inputTokens += usage.prompt_tokens;
      if (Number.isFinite(usage?.completion_tokens) && usage.completion_tokens >= 0) state.outputTokens += usage.completion_tokens;
    },
    snapshot: () => ({
      startedAt: state.startedAt,
      requests: state.requests,
      errors: state.errors,
      cancelled: state.cancelled,
      modelCalls: state.modelCalls,
      speechCalls: state.speechCalls,
      tokens: { input: state.inputTokens, output: state.outputTokens },
      latency: { p50: percentile(state.durations, 0.5), p95: percentile(state.durations, 0.95), firstLineP50: percentile(state.firstLines, 0.5), firstAudioP50: percentile(state.firstAudio, 0.5) },
      providers: { text: { configured: Boolean(env.SCENE_API_KEY), model: env.SCENE_MODEL || 'gpt-4.1-mini' }, voice: { configured: Boolean(env.SCENE_VOICE_API_KEY), model: env.SCENE_TTS_MODEL || 'tts-1' } },
      recent: [...state.recent].reverse(),
    }),
  };
}
