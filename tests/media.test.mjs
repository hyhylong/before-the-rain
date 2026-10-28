import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PNG } from 'pngjs';
import { createApp } from '../server/app.mjs';
import { createMediaRouter, validateImage } from '../server/media.mjs';

function imageBytes(blank = false) {
  const image = new PNG({ width: 96, height: 80 });
  for (let y = 0; y < image.height; y++) for (let x = 0; x < image.width; x++) {
    const index = (y * image.width + x) * 4;
    image.data[index] = blank ? 255 : Math.round(x * 255 / 95);
    image.data[index + 1] = blank ? 255 : Math.round(y * 255 / 79);
    image.data[index + 2] = blank ? 255 : 80;
    image.data[index + 3] = 255;
  }
  return PNG.sync.write(image);
}
const png = imageBytes();
const reference = `data:image/png;base64,${png.toString('base64')}`;

async function server(t, options = {}) {
  const router = createMediaRouter({ env: {}, mockDelayMs: 2, pollDelayMs: 2, ...options });
  const instance = createApp({ env: options.env || {}, mediaRouter: router }).listen(0, '127.0.0.1');
  await once(instance, 'listening');
  t.after(() => { instance.closeAllConnections(); instance.close(); });
  const base = `http://127.0.0.1:${instance.address().port}`;
  const start = async (overrides = {}) => {
    const response = await fetch(`${base}/api/media/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: 'media-test', turnId: 1, kind: 'image', mode: 'mock', prompt: '窗边的一张合影', reference, ...overrides }) });
    return { status: response.status, body: await response.json() };
  };
  const get = (id) => fetch(`${base}/api/media/jobs/${id}`).then((response) => response.json());
  const cancel = (id) => fetch(`${base}/api/media/jobs/${id}`, { method: 'DELETE' }).then((response) => response.json());
  const capabilities = () => fetch(`${base}/api/media/capabilities`).then((response) => response.json());
  const finished = async (id) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const job = await get(id);
      if (['ready', 'failed', 'cancelled'].includes(job.status)) return job;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error('Media job did not settle');
  };
  return { base, start, get, cancel, capabilities, finished };
}

test('mock image jobs keep their replay identity and serve the actual reference bytes', async (t) => {
  const api = await server(t);
  const started = await api.start();
  assert.equal(started.status, 202);
  assert.equal(started.body.status, 'queued');
  const job = await api.finished(started.body.id);
  assert.equal(job.status, 'ready');
  assert.equal(job.source, 'replay');
  assert.equal(job.result.source, 'replay');
  assert.deepEqual([job.result.width, job.result.height], [96, 80]);
  const asset = await fetch(`${api.base}${job.result.url}`);
  assert.equal(asset.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await asset.arrayBuffer()), png);
  const cached = await api.start({ clientJobId: randomUUID() });
  assert.equal(cached.body.status, 'ready');
  assert.equal(cached.body.cached, true);
  assert.equal((await api.capabilities()).counts.cacheHits, 1);
});

test('persisted media assets are readable inside the default hidden data directory', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mira-hidden-media-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const api = await server(t, { dataDir: path.join(directory, '.data', 'media') });
  const started = await api.start();
  const job = await api.finished(started.body.id);
  assert.equal(job.status, 'ready');
  const asset = await fetch(`${api.base}${job.result.url}`);
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get('content-type'), 'image/png');
  assert.match(asset.headers.get('cache-control'), /immutable/);
  assert.deepEqual(Buffer.from(await asset.arrayBuffer()), png);
  const index = await fetch(`${api.base}/api/media/assets/index.json`);
  assert.equal(index.status, 404);
});

test('mock video selects content-driven local clips and deliberate failures never enter the cache', async (t) => {
  const api = await server(t);
  const start = await api.start({ kind: 'video', prompt: '雨停了，走到外面' });
  const job = await api.finished(start.body.id);
  assert.equal(job.result.url, '/video/rain.webm');
  assert.equal(job.result.poster, '/video/rain.jpg');
  assert.equal(job.source, 'replay');
  const failed = await api.start({ fault: 'failure' });
  const failure = await api.finished(failed.body.id);
  assert.equal(failure.status, 'failed');
  assert.equal(failure.error.code, 'MEDIA_DEMO_FAILURE');
  assert.equal((await api.capabilities()).counts.failed, 1);
});

test('cancelling an in-flight job prevents a late result or cache insertion', async (t) => {
  const api = await server(t, { mockDelayMs: 40 });
  const start = await api.start();
  await api.cancel(start.body.id);
  await new Promise((resolve) => setTimeout(resolve, 85));
  const cancelled = await api.get(start.body.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.result, undefined);
  const capabilities = await api.capabilities();
  assert.equal(capabilities.cacheEntries, 0);
  assert.equal(capabilities.counts.generated, 0);
  assert.equal(capabilities.counts.cancelled, 1);
});

test('cancellation before POST wins even when an identical result is already cached', async (t) => {
  const api = await server(t);
  const first = await api.start();
  await api.finished(first.body.id);
  const id = randomUUID();
  await api.cancel(id);
  const late = await api.start({ clientJobId: id });
  assert.equal(late.body.status, 'cancelled');
  assert.equal(late.body.cached, false);
  assert.equal(late.body.result, undefined);
  const capabilities = await api.capabilities();
  assert.equal(capabilities.counts.generated, 1);
  assert.equal(capabilities.counts.cacheHits, 0);
  assert.equal(capabilities.counts.cancelled, 1);
  assert.equal(capabilities.inFlight, 0);
});

test('cancellation before an uncached POST does not start a provider', async (t) => {
  let calls = 0;
  const api = await server(t, { env: { SCENE_IMAGE_API_KEY: 'private' }, fetcher: async () => { calls += 1; throw new Error('Provider must not run'); } });
  const id = randomUUID();
  await api.cancel(id);
  const late = await api.start({ clientJobId: id, mode: 'live' });
  assert.equal(late.body.status, 'cancelled');
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(calls, 0);
});

test('live image edits use the exact character reference and keep private provider values out of results', async (t) => {
  let calls = 0;
  const fetcher = async (url, options) => {
    calls += 1;
    assert.equal(url, 'https://image.invalid/v1/images/edits');
    assert.equal(options.headers.Authorization, 'Bearer image-private-value');
    assert.ok(options.body instanceof FormData);
    assert.deepEqual(Buffer.from(await options.body.get('image').arrayBuffer()), png);
    assert.match(options.body.get('prompt'), /26-year-old/);
    assert.match(options.body.get('prompt'), /silver star hair clip/);
    assert.match(options.body.get('prompt'), /窗边的一张合影/);
    return Response.json({ data: [{ b64_json: png.toString('base64') }] });
  };
  const api = await server(t, { env: { SCENE_IMAGE_API_KEY: 'image-private-value', SCENE_IMAGE_BASE_URL: 'https://image.invalid/v1', SCENE_IMAGE_MODEL: 'custom-image' }, fetcher });
  const started = await api.start({ mode: 'live' });
  const job = await api.finished(started.body.id);
  assert.equal(job.status, 'ready');
  assert.equal(job.result.source, 'generated');
  assert.equal(calls, 1);
  assert.ok(!JSON.stringify(job).includes('image-private-value'));
  assert.equal((await api.capabilities()).imageAvailable, true);
});

test('image generation without a reference uses the compatible JSON generation endpoint', async (t) => {
  const fetcher = async (url, options) => {
    assert.equal(url, 'https://image.invalid/v1/images/generations');
    assert.equal(options.headers['Content-Type'], 'application/json');
    const payload = JSON.parse(options.body);
    assert.equal(payload.model, 'custom-image');
    assert.equal(payload.output_format, 'png');
    return Response.json({ data: [{ b64_json: png.toString('base64') }] });
  };
  const api = await server(t, { env: { SCENE_IMAGE_API_KEY: 'private', SCENE_IMAGE_BASE_URL: 'https://image.invalid/v1', SCENE_IMAGE_MODEL: 'custom-image' }, fetcher });
  const start = await api.start({ mode: 'live', reference: undefined });
  assert.equal((await api.finished(start.body.id)).status, 'ready');
});

test('blank remote images fail visibly and cannot poison the image cache', async (t) => {
  const fetcher = async () => Response.json({ data: [{ b64_json: imageBytes(true).toString('base64') }] });
  const api = await server(t, { env: { SCENE_IMAGE_API_KEY: 'private' }, fetcher });
  const start = await api.start({ mode: 'live' });
  const job = await api.finished(start.body.id);
  assert.equal(job.status, 'failed');
  assert.equal(job.error.code, 'BLANK_IMAGE');
  assert.equal((await api.capabilities()).cacheEntries, 0);
  assert.throws(() => validateImage(Buffer.from('invalid')), { code: 'INVALID_IMAGE' });
});

test('generated image cache and actual assets survive router recreation', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mira-media-cache-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  let calls = 0;
  const options = { dataDir: directory, env: { SCENE_IMAGE_API_KEY: 'private', SCENE_IMAGE_MODEL: 'image' }, fetcher: async () => { calls += 1; return Response.json({ data: [{ b64_json: png.toString('base64') }] }); } };
  const first = await server(t, options);
  const start = await first.start({ mode: 'live' });
  const original = await first.finished(start.body.id);
  const restored = await server(t, options);
  const cached = await restored.start({ mode: 'live' });
  assert.equal(cached.body.cached, true);
  assert.equal(cached.body.result.url, original.result.url);
  assert.equal(calls, 1);
  const bytes = await fetch(`${restored.base}${cached.body.result.url}`).then((response) => response.arrayBuffer());
  assert.deepEqual(Buffer.from(bytes), png);
});

test('video generation requires an explicit active compatible provider and never falls back to retired OpenAI video endpoints', async (t) => {
  for (const [name, env, code] of [
    ['missing configuration', { SCENE_VIDEO_API_KEY: 'private' }, 'VIDEO_NOT_CONFIGURED'],
    ['retired endpoint', { SCENE_VIDEO_API_KEY: 'private', SCENE_VIDEO_BASE_URL: 'https://api.openai.com/v1', SCENE_VIDEO_MODEL: 'sora-2' }, 'VIDEO_PROVIDER_RETIRED'],
    ['retired endpoint with final dot', { SCENE_VIDEO_API_KEY: 'private', SCENE_VIDEO_BASE_URL: 'https://api.openai.com./v1', SCENE_VIDEO_MODEL: 'custom' }, 'VIDEO_PROVIDER_RETIRED'],
    ['unsupported protocol', { SCENE_VIDEO_API_KEY: 'private', SCENE_VIDEO_BASE_URL: 'file:///tmp/video', SCENE_VIDEO_MODEL: 'custom' }, 'VIDEO_CONFIG'],
  ]) {
    await t.test(name, async (subtest) => {
      let calls = 0;
      const api = await server(subtest, { env, fetcher: async () => { calls += 1; throw new Error('Must not use unavailable video provider'); } });
      assert.equal((await api.capabilities()).videoAvailable, false);
      const started = await api.start({ kind: 'video', mode: 'live' });
      const job = await api.finished(started.body.id);
      assert.equal(job.status, 'failed');
      assert.equal(job.error.code, code);
      assert.equal(calls, 0);
    });
  }
});

test('explicit compatible video provider creates, polls, downloads, and caches a generated MP4', async (t) => {
  const mp4 = await readFile(new URL('./fixtures/video-provider.mp4', import.meta.url));
  const calls = [];
  let polls = 0;
  const fetcher = async (url, options) => {
    calls.push(url);
    assert.equal(options.headers.Authorization, 'Bearer video-private');
    if (url.endsWith('/videos')) {
      assert.equal(options.method, 'POST');
      assert.equal(options.body.get('model'), 'active-video-model');
      assert.equal(options.body.get('seconds'), '8');
      assert.deepEqual(Buffer.from(await options.body.get('input_reference').arrayBuffer()), png);
      return Response.json({ id: 'video_test', status: 'queued', progress: 0 });
    }
    if (url.endsWith('/content')) return new Response(mp4, { headers: { 'Content-Type': 'video/mp4' } });
    polls += 1;
    return Response.json({ id: 'video_test', status: polls > 1 ? 'completed' : 'in_progress', progress: polls > 1 ? 100 : 40 });
  };
  const api = await server(t, { env: { SCENE_VIDEO_API_KEY: 'video-private', SCENE_VIDEO_BASE_URL: 'https://video.invalid/v1', SCENE_VIDEO_MODEL: 'active-video-model' }, fetcher });
  assert.equal((await api.capabilities()).videoAvailable, true);
  const started = await api.start({ kind: 'video', mode: 'live' });
  const job = await api.finished(started.body.id);
  assert.equal(job.status, 'ready');
  assert.equal(job.result.source, 'generated');
  assert.equal(calls.length, 4);
  const bytes = await fetch(`${api.base}${job.result.url}`).then((response) => response.arrayBuffer());
  assert.deepEqual(Buffer.from(bytes), mp4);
  const cached = await api.start({ kind: 'video', mode: 'live' });
  assert.equal(cached.body.cached, true);
  assert.equal(calls.length, 4);
});

test('video provider failures and oversized content remain recoverable job errors', async (t) => {
  const env = { SCENE_VIDEO_API_KEY: 'video-private', SCENE_VIDEO_BASE_URL: 'https://video.invalid/v1', SCENE_VIDEO_MODEL: 'active-video-model' };
  for (const failure of ['failed', 'oversized']) await t.test(failure, async (subtest) => {
    const api = await server(subtest, { env, fetcher: async (url) => {
      if (url.endsWith('/content')) return new Response('body', { headers: { 'Content-Length': String(49 * 1024 * 1024) } });
      return Response.json({ id: 'video_test', status: failure === 'failed' ? 'failed' : 'completed', error: { message: 'video-private' } });
    } });
    const started = await api.start({ kind: 'video', mode: 'live' });
    const job = await api.finished(started.body.id);
    assert.equal(job.status, 'failed');
    assert.equal(job.error.code, failure === 'failed' ? 'VIDEO_FAILED' : 'MEDIA_TOO_LARGE');
    assert.ok(!JSON.stringify(job).includes('video-private'));
    assert.equal((await api.capabilities()).cacheEntries, 0);
  });
});
