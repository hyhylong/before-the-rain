import express from 'express';
import { z } from 'zod';
import { PNG } from 'pngjs';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { SceneError, sessionIdSchema } from './protocol.mjs';

const jobSchema = z.object({
  sessionId: sessionIdSchema,
  turnId: z.number().int().nonnegative(),
  kind: z.enum(['image', 'video']),
  mode: z.enum(['mock', 'live']).default('mock'),
  prompt: z.string().trim().min(1).max(1600),
  reference: z.string().max(4 * 1024 * 1024).optional(),
  fault: z.enum(['none', 'failure']).default('none'),
  clientJobId: z.string().uuid().optional(),
}).strict();

const identity = 'An original adult character Mira, a 26-year-old travel photographer, amber raincoat, dark bob hair, silver star hair clip, camera. Preserve the exact face, outfit, hair, and cafe from the reference image. Tasteful stylized 3D artwork. No other people, no text. ';
const hash = (value) => createHash('sha256').update(value).digest('hex');

export function validateImage(bytes) {
  if (bytes.length < 24 || bytes.readUInt32BE(16) > 4096 || bytes.readUInt32BE(20) > 4096) throw new SceneError('INVALID_IMAGE', '画面尺寸异常，请重新创作。', 502, true);
  let image;
  try { image = PNG.sync.read(bytes, { checkCRC: true }); } catch { throw new SceneError('INVALID_IMAGE', '这张画面没有成功显影，请重新创作。', 502, true); }
  if (image.width < 64 || image.height < 64 || image.width > 4096 || image.height > 4096) throw new SceneError('INVALID_IMAGE', '画面尺寸异常，请重新创作。', 502, true);
  let sum = 0; let squares = 0; let visible = 0; let count = 0;
  const step = Math.max(4, Math.floor(image.data.length / 4096 / 4) * 4);
  for (let i = 0; i < image.data.length; i += step) {
    const light = (image.data[i] + image.data[i + 1] + image.data[i + 2]) / 3;
    sum += light; squares += light * light; count += 1;
    if (image.data[i + 3] > 32) visible += 1;
  }
  if (visible / count < 0.2 || Math.sqrt(squares / count - (sum / count) ** 2) < 3) throw new SceneError('BLANK_IMAGE', '画面似乎没有完整生成，请再试一次。', 502, true);
  return { width: image.width, height: image.height };
}

function referenceBytes(reference) {
  if (!reference) return null;
  if (!reference.startsWith('data:image/png;base64,')) throw new SceneError('INVALID_REFERENCE', '参考画面需要 PNG 格式。', 400);
  const bytes = Buffer.from(reference.slice('data:image/png;base64,'.length), 'base64');
  if (bytes.length > 3 * 1024 * 1024) throw new SceneError('REFERENCE_TOO_LARGE', '参考画面过大。', 400);
  validateImage(bytes);
  return bytes;
}

function apiUrl(base, route) {
  const url = new URL(base || 'https://api.openai.com/v1');
  if (!['http:', 'https:'].includes(url.protocol)) throw new SceneError('MEDIA_CONFIG', '创作服务地址配置有误。', 503);
  return `${url.href.replace(/\/$/, '')}/${route}`;
}

function videoConfiguration(env) {
  if (!env.SCENE_VIDEO_API_KEY || !env.SCENE_VIDEO_BASE_URL?.trim() || !env.SCENE_VIDEO_MODEL?.trim()) {
    return { available: false, code: 'VIDEO_NOT_CONFIGURED', message: '视频服务需要明确配置密钥、兼容服务地址和模型，可以先看剧情回放。' };
  }
  let url;
  try { url = new URL(env.SCENE_VIDEO_BASE_URL); } catch { return { available: false, code: 'VIDEO_CONFIG', message: '视频服务地址配置无效。' }; }
  if (!['http:', 'https:'].includes(url.protocol)) return { available: false, code: 'VIDEO_CONFIG', message: '视频服务地址需要使用 HTTP 或 HTTPS。' };
  if (url.hostname.toLowerCase().replace(/\.$/, '') === 'api.openai.com') {
    return { available: false, code: 'VIDEO_PROVIDER_RETIRED', message: '此视频接口已停用，请明确配置仍提供 /videos 兼容接口的服务与模型。' };
  }
  return { available: true };
}

async function readBounded(response, max = 48 * 1024 * 1024) {
  if (Number(response.headers.get('content-length')) > max) throw new SceneError('MEDIA_TOO_LARGE', '生成的媒体过大，请尝试较短的片段。', 502, true);
  const chunks = []; let length = 0;
  for await (const chunk of response.body) {
    length += chunk.length;
    if (length > max) { await response.body.cancel?.().catch(() => {}); throw new SceneError('MEDIA_TOO_LARGE', '生成的媒体过大。', 502, true); }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export function createMediaRouter({ env = process.env, fetcher = fetch, dataDir = false, mockDelayMs = 350, pollDelayMs = 1500 } = {}) {
  const router = express.Router();
  const directory = dataDir ? path.resolve(dataDir) : null;
  if (directory) mkdirSync(directory, { recursive: true });
  const jobs = new Map();
  const cancelledIds = new Set();
  const assets = new Map();
  const cache = new Map();
  const counts = { requested: 0, generated: 0, failed: 0, cancelled: 0, cacheHits: 0 };
  if (directory && existsSync(path.join(directory, 'index.json'))) {
    try {
      for (const [key, entry] of JSON.parse(readFileSync(path.join(directory, 'index.json'), 'utf8'))) {
        if (entry.url?.startsWith('/video/') || existsSync(path.join(directory, entry.assetId || 'missing'))) cache.set(key, entry);
      }
    } catch { /* An interrupted cache write must not prevent the scene from starting. */ }
  }
  const persistCache = () => {
    if (!directory) return;
    const file = path.join(directory, 'index.json');
    writeFileSync(`${file}.tmp`, JSON.stringify([...cache.entries()].slice(-80)));
    renameSync(`${file}.tmp`, file);
  };
  const snapshot = (job) => ({ id: job.id, turnId: job.turnId, kind: job.kind, status: job.status, progress: job.progress, source: job.source, result: job.result, error: job.error, cached: job.cached, createdAt: job.createdAt });
  const saveAsset = (bytes, extension) => {
    const assetId = `${hash(bytes)}.${extension}`;
    if (directory) writeFileSync(path.join(directory, assetId), bytes);
    else assets.set(assetId, bytes);
    return { assetId, url: `/api/media/assets/${assetId}` };
  };

  async function generate(job, request, reference, key) {
    const signal = job.controller.signal;
    const timeout = setTimeout(() => job.controller.abort('timeout'), Math.max(1000, Number(env.SCENE_MEDIA_TIMEOUT_MS) || 180000));
    try {
      job.status = 'generating'; job.progress = 12;
      if (request.fault === 'failure') { await delay(mockDelayMs, null, { signal }); throw new SceneError('MEDIA_DEMO_FAILURE', '这次创作没有完成，原来的场景仍在。可以重试。', 502, true); }
      if (request.mode === 'mock') {
        await delay(mockDelayMs, null, { signal }); job.progress = 65;
        if (request.kind === 'image') {
          if (!reference) throw new SceneError('REFERENCE_REQUIRED', '请先等待角色画面加载。', 400, true);
          const dimensions = validateImage(reference);
          job.result = { ...saveAsset(reference, 'png'), ...dimensions, source: 'replay' };
        } else {
          const clip = /雨|离开|出发|rain|outside/i.test(request.prompt) ? 'rain' : 'memory';
          job.result = { url: `/video/${clip}.webm`, poster: `/video/${clip}.jpg`, clip, source: 'replay' };
        }
        await delay(mockDelayMs, null, { signal });
      } else if (request.kind === 'image') {
        if (!env.SCENE_IMAGE_API_KEY) throw new SceneError('IMAGE_NOT_CONFIGURED', '图片创作服务尚未连接，可以先看场景回放。', 503);
        const fields = { model: env.SCENE_IMAGE_MODEL || 'gpt-image-2', prompt: `${identity}${request.prompt}`, size: '1536x1024', output_format: 'png' };
        const headers = { Authorization: `Bearer ${env.SCENE_IMAGE_API_KEY}` };
        let body;
        if (reference) {
          body = new FormData();
          for (const [field, value] of Object.entries(fields)) body.set(field, value);
          body.set('image', new Blob([reference], { type: 'image/png' }), 'mira-reference.png');
        } else {
          headers['Content-Type'] = 'application/json';
          body = JSON.stringify(fields);
        }
        const response = await fetcher(apiUrl(env.SCENE_IMAGE_BASE_URL, reference ? 'images/edits' : 'images/generations'), { method: 'POST', headers, body, signal });
        if (!response.ok) throw new SceneError('IMAGE_PROVIDER_ERROR', '图片服务暂时无法完成这次创作，请重试。', 502, true);
        const payload = await response.json();
        const encoded = payload.data?.[0]?.b64_json;
        if (typeof encoded !== 'string' || encoded.length > 24 * 1024 * 1024) throw new SceneError('INVALID_IMAGE', '图片服务没有返回有效的 PNG 画面。', 502, true);
        const bytes = Buffer.from(encoded, 'base64');
        const dimensions = validateImage(bytes); job.progress = 92;
        job.result = { ...saveAsset(bytes, 'png'), ...dimensions, source: 'generated' };
      } else {
        const configuration = videoConfiguration(env);
        if (!configuration.available) throw new SceneError(configuration.code, configuration.message, 503);
        const headers = { Authorization: `Bearer ${env.SCENE_VIDEO_API_KEY}` };
        const form = new FormData();
        form.set('model', env.SCENE_VIDEO_MODEL.trim()); form.set('seconds', '8'); form.set('size', '1280x720');
        form.set('prompt', `${identity}A continuous gentle cinematic shot, subtle natural movement, no cuts. ${request.prompt}`);
        if (reference) form.set('input_reference', new Blob([reference], { type: 'image/png' }), 'mira-reference.png');
        const response = await fetcher(apiUrl(env.SCENE_VIDEO_BASE_URL, 'videos'), { method: 'POST', headers, body: form, signal });
        if (!response.ok) throw new SceneError('VIDEO_PROVIDER_ERROR', '视频服务暂时无法开始创作，请重试。', 502, true);
        let remote = await response.json();
        if (typeof remote.id !== 'string' || !/^[a-zA-Z0-9_-]{1,160}$/.test(remote.id)) throw new SceneError('INVALID_VIDEO_JOB', '视频服务没有返回有效的任务。', 502, true);
        const remoteId = remote.id;
        while (remote.status !== 'completed') {
          if (['failed', 'cancelled'].includes(remote.status)) throw new SceneError('VIDEO_FAILED', '这段视频没有成功完成，可以保留原画面重试。', 502, true);
          job.progress = Math.min(92, Math.max(15, Number(remote.progress) || job.progress + 1));
          await delay(pollDelayMs, null, { signal });
          const status = await fetcher(apiUrl(env.SCENE_VIDEO_BASE_URL, `videos/${remoteId}`), { headers, signal });
          if (!status.ok) throw new SceneError('VIDEO_POLL_ERROR', '视频创作连接暂时中断，请重试。', 502, true);
          remote = await status.json();
        }
        const content = await fetcher(apiUrl(env.SCENE_VIDEO_BASE_URL, `videos/${remoteId}/content`), { headers, signal });
        if (!content.ok) throw new SceneError('VIDEO_DOWNLOAD_ERROR', '视频已经生成，但加载失败了。可以重试。', 502, true);
        const bytes = await readBounded(content);
        if (bytes.length < 64 || bytes.toString('ascii', 4, 8) !== 'ftyp') throw new SceneError('INVALID_VIDEO', '视频文件不完整，请重新创作。', 502, true);
        job.result = { ...saveAsset(bytes, 'mp4'), source: 'generated' };
      }
      if (signal.aborted) return;
      job.status = 'ready'; job.progress = 100; counts.generated += 1;
      cache.set(key, { ...job.result, source: job.source }); persistCache();
    } catch (error) {
      if (signal.aborted) {
        job.status = signal.reason === 'timeout' ? 'failed' : 'cancelled';
        if (job.status === 'failed') { counts.failed += 1; job.error = { code: 'MEDIA_TIMEOUT', message: '创作等待超时，可以重试。', retryable: true }; }
      } else {
        job.status = 'failed'; counts.failed += 1;
        job.error = { code: error instanceof SceneError ? error.code : 'MEDIA_FAILED', message: error instanceof SceneError ? error.message : '创作暂时没有完成，请重试。', retryable: true };
      }
    } finally { clearTimeout(timeout); }
  }

  router.get('/media/capabilities', (_req, res) => res.json({ imageAvailable: Boolean(env.SCENE_IMAGE_API_KEY), videoAvailable: videoConfiguration(env).available, videoRequiredConfiguration: ['SCENE_VIDEO_API_KEY', 'SCENE_VIDEO_BASE_URL', 'SCENE_VIDEO_MODEL'], cacheEntries: cache.size, inFlight: [...jobs.values()].filter((job) => ['queued', 'generating'].includes(job.status)).length, counts }));
  router.post('/media/jobs', (req, res, next) => {
    try {
      const request = jobSchema.parse(req.body);
      const reference = referenceBytes(request.reference);
      if ([...jobs.values()].filter((job) => ['queued', 'generating'].includes(job.status)).length >= 4) throw new SceneError('MEDIA_BUSY', '创作中的画面有点多，请稍后再试。', 429, true);
      if (jobs.size > 150) for (const [id, job] of jobs) { if (!['queued', 'generating'].includes(job.status)) { jobs.delete(id); if (jobs.size <= 100) break; } }
      const model = request.kind === 'image' ? env.SCENE_IMAGE_MODEL : env.SCENE_VIDEO_MODEL;
      const base = request.kind === 'image' ? env.SCENE_IMAGE_BASE_URL : env.SCENE_VIDEO_BASE_URL;
      const key = hash(JSON.stringify({ kind: request.kind, mode: request.mode, prompt: request.prompt, reference: reference ? hash(reference) : null, model, base }));
      const id = request.clientJobId || randomUUID();
      if (jobs.has(id)) return res.status(202).json(snapshot(jobs.get(id)));
      const job = { id, turnId: request.turnId, sessionId: request.sessionId, kind: request.kind, status: cancelledIds.has(id) ? 'cancelled' : 'queued', progress: 0, source: request.mode === 'mock' ? 'replay' : 'generated', createdAt: new Date().toISOString(), controller: new AbortController(), cached: false };
      const hit = job.status !== 'cancelled' && request.fault === 'none' && cache.get(key);
      if (hit) { job.result = hit; job.status = 'ready'; job.progress = 100; job.cached = true; counts.cacheHits += 1; }
      jobs.set(job.id, job); counts.requested += 1;
      if (job.status === 'cancelled') counts.cancelled += 1;
      res.status(202).json(snapshot(job));
      if (!hit && job.status !== 'cancelled') void generate(job, request, reference, key);
    } catch (error) { next(error); }
  });
  router.get('/media/jobs/:id', (req, res) => {
    const job = jobs.get(req.params.id);
    if (!job) return res.status(404).json({ error: { code: 'MEDIA_NOT_FOUND', message: '这次创作已失效，请重新开始。', retryable: true } });
    res.json(snapshot(job));
  });
  router.delete('/media/jobs/:id', (req, res) => {
    if (/^[a-f0-9-]{36}$/.test(req.params.id)) { cancelledIds.add(req.params.id); if (cancelledIds.size > 200) cancelledIds.delete(cancelledIds.values().next().value); }
    const job = jobs.get(req.params.id);
    if (job && ['queued', 'generating'].includes(job.status)) { job.controller.abort('user'); job.status = 'cancelled'; counts.cancelled += 1; }
    res.json({ ok: true });
  });
  router.get('/media/assets/:id', (req, res) => {
    const { id } = req.params;
    if (!/^[a-f0-9]{64}\.(png|mp4)$/.test(id)) return res.sendStatus(404);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.type(id.endsWith('.png') ? 'image/png' : 'video/mp4');
    if (directory && existsSync(path.join(directory, id))) return res.sendFile(path.join(directory, id), { dotfiles: 'allow' });
    const bytes = assets.get(id);
    if (!bytes) return res.sendStatus(404);
    res.send(bytes);
  });
  return router;
}
