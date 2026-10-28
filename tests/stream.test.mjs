import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.mjs';

async function server(t, options = {}) {
  const instance = createApp({ env: {}, mockDelayMs: 1, streamDelayMs: 1, ...options }).listen(0, '127.0.0.1');
  await once(instance, 'listening');
  t.after(() => { instance.closeAllConnections(); instance.close(); });
  const base = `http://127.0.0.1:${instance.address().port}`;
  const post = (route, body, signal) => fetch(`${base}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  const stream = (turnId, message, extra = {}, signal) => post('/api/turn/stream', { sessionId: 'stream-test', turnId, message, mode: 'mock', ...extra }, signal);
  const snapshot = () => fetch(`${base}/api/session/stream-test`).then((response) => response.json());
  const ack = (turnId, lineIndex) => post('/api/session/ack', { sessionId: 'stream-test', turnId, lineIndex });
  return { base, post, stream, snapshot, ack };
}

const events = async (response) => (await response.text()).trim().split('\n').map((line) => JSON.parse(line));
const line = (text) => ({ text, emotion: 'warm', gesture: 'nod' });
const sse = (content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`;

test('mock streaming publishes per-line cues and only acknowledged cues advance narrative state', async (t) => {
  const { stream, snapshot, ack } = await server(t);
  const reply = await events(await stream(1, '看看照片'));
  assert.equal(reply.filter((event) => event.type === 'line').length, 3);
  assert.equal(reply.at(-1).type, 'final');
  assert.equal(reply[0].line.video, 'memory');
  assert.equal((await snapshot()).state.photoShown, false);
  assert.equal((await snapshot()).state.turnCount, 0);
  assert.equal((await ack(1, 2)).status, 409);
  const applied = await (await ack(1, 0)).json();
  assert.equal(applied.state.photoShown, true);
  assert.equal(applied.state.turnCount, 1);
  const duplicate = await (await ack(1, 0)).json();
  assert.equal(duplicate.state.turnCount, 1);
  assert.equal((await snapshot()).acknowledgedLine, 0);
});

test('cancelling between streamed lines discards unplayed cues and a newer turn invalidates old acknowledgements', async (t) => {
  const { stream, ack, snapshot } = await server(t, { streamDelayMs: 150 });
  const controller = new AbortController();
  const response = await stream(1, '看看照片', {}, controller.signal);
  const reader = response.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.equal(JSON.parse(first.trim()).type, 'line');
  controller.abort();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal((await snapshot()).state.photoShown, false);
  const newer = await events(await stream(2, '喝热茶'));
  assert.equal(newer.at(-1).state.photoShown, false);
  assert.equal((await ack(1, 0)).status, 409);
  assert.equal((await ack(2, 0)).status, 200);
  assert.equal((await snapshot()).state.turnCount, 1);
});

test('streaming state survives process recreation and reset removes durable records', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mira-sessions-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const first = await server(t, { dataDir: directory });
  await events(await first.stream(5, '雨停了'));
  await first.ack(5, 0);
  const disk = JSON.parse(await readFile(path.join(directory, 'stream-test.json'), 'utf8'));
  assert.equal(disk.state.scene, 'clearing');
  assert.equal(disk.controller, undefined);
  const restored = await server(t, { dataDir: directory });
  const recovered = await restored.snapshot();
  assert.equal(recovered.lastTurnId, 5);
  assert.equal(recovered.state.scene, 'clearing');
  assert.equal(recovered.acknowledgedLine, 0);
  assert.equal(recovered.latestReply.lines.length, 3);
  assert.equal((await restored.ack(5, 1)).status, 200);
  assert.equal((await restored.snapshot()).acknowledgedLine, 1);
  assert.equal((await restored.snapshot()).state.turnCount, 1);
  assert.equal((await restored.stream(5, '迟到的请求')).status, 409);
  await restored.post('/api/session/reset', { sessionId: 'stream-test' });
  await assert.rejects(readFile(path.join(directory, 'stream-test.json')), { code: 'ENOENT' });
});

test('damaged persisted sessions are isolated and cannot prevent healthy session restoration', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mira-corrupt-session-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await writeFile(path.join(directory, 'damaged.json'), '{invalid');
  const instance = await server(t, { dataDir: directory });
  const completed = await events(await instance.stream(1, '你好'));
  assert.equal(completed.at(-1).type, 'final');
});

test('live structured tokens stream valid complete lines before the provider finishes', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const first = { ...line('她说：“等一等 { 这里还有光 }。”'), media: 'photo', video: 'memory' };
  const second = line('云后面的灯塔依然亮着。');
  const prefix = `{"lines":[${JSON.stringify(first)},`;
  const suffix = `${JSON.stringify(second)}],"choices":["继续"],"chapter":"灯塔"}`;
  const encoder = new TextEncoder();
  const fetcher = async (_url, options) => {
    assert.equal(JSON.parse(options.body).stream, true);
    assert.equal(Object.hasOwn(JSON.parse(options.body), 'thinking'), false);
    return new Response(new ReadableStream({
      async start(controller) {
        const initial = encoder.encode(sse(prefix.slice(0, 11)) + sse(prefix.slice(11)));
        for (let at = 0; at < initial.length; at += 7) controller.enqueue(initial.slice(at, at + 7));
        await gate;
        controller.enqueue(encoder.encode(sse(suffix) + 'data: [DONE]\n\n'));
        controller.close();
      },
    }), { headers: { 'Content-Type': 'text/event-stream' } });
  };
  const { stream, snapshot, ack, base } = await server(t, { env: { SCENE_API_KEY: 'private-not-exposed' }, fetcher });
  const response = await stream(1, '看照片', { mode: 'live' });
  const reader = response.body.getReader();
  const firstEvent = JSON.parse(new TextDecoder().decode((await reader.read()).value).trim());
  assert.equal(firstEvent.type, 'line');
  assert.equal(firstEvent.line.text, first.text);
  assert.equal((await ack(1, 0)).status, 200);
  assert.equal((await snapshot()).state.photoShown, true);
  release();
  let rest = '';
  for (;;) { const chunk = await reader.read(); if (chunk.done) break; rest += new TextDecoder().decode(chunk.value); }
  const tail = rest.trim().split('\n').map((value) => JSON.parse(value));
  assert.equal(tail.at(-1).type, 'final');
  assert.equal(tail.at(-1).lines.length, 2);
  const measured = await fetch(`${base}/api/metrics`).then((res) => res.json());
  assert.equal(measured.modelCalls, 1);
  assert.ok(!JSON.stringify(measured).includes('private-not-exposed'));
  assert.ok(!JSON.stringify(measured).includes(first.text));
});

test('DeepSeek streaming replies preserve the configured model and disabled thinking mode', async (t) => {
  const reply = { lines: [line('先坐一会儿吧，咖啡还温着。')], choices: ['坐一会儿'], chapter: '窗边' };
  const requests = [];
  const fetcher = async (url, options) => {
    requests.push({ url, method: options.method, body: JSON.parse(options.body) });
    return new Response(sse(JSON.stringify(reply)) + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  };
  const { stream } = await server(t, {
    env: { SCENE_API_KEY: 'deepseek-test-only', SCENE_API_BASE_URL: 'https://api.deepseek.com/', SCENE_MODEL: 'deepseek-flash', SCENE_THINKING: 'disabled' },
    fetcher,
  });
  const response = await stream(1, '你好', { mode: 'live' });
  assert.equal(response.status, 200);
  const result = await events(response);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://api.deepseek.com/chat/completions');
  assert.equal(requests[0].method, 'POST');
  assert.equal(requests[0].body.model, 'deepseek-flash');
  assert.deepEqual(requests[0].body.thinking, { type: 'disabled' });
  assert.equal(requests[0].body.stream, true);
  assert.deepEqual(requests[0].body.stream_options, { include_usage: true });
  assert.deepEqual(result[0].line, reply.lines[0]);
  assert.equal(result.at(-1).type, 'final');
  assert.deepEqual(result.at(-1).lines, reply.lines);
});

test('invalid late structured tokens emit an explicit error without publishing their cue', async (t) => {
  const valid = line('这一句已经通过校验。');
  const invalid = { ...line('失效图片不该显示'), media: 'unsafe-url' };
  const content = JSON.stringify({ lines: [valid, invalid], choices: ['继续'], chapter: '窗边' });
  const fetcher = async () => new Response(sse(content) + 'data: [DONE]\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  const { stream } = await server(t, { env: { SCENE_API_KEY: 'private' }, fetcher });
  const result = await events(await stream(1, '你好', { mode: 'live' }));
  assert.equal(result.at(-1).type, 'error');
  assert.equal(result.at(-1).error.code, 'INVALID_MODEL_REPLY');
  assert.ok(!result.some((event) => event.line?.media === 'unsafe-url'));
  assert.ok(!result.some((event) => event.type === 'final'));
});

test('stream faults are visible and error observations contain sanitized codes', async (t) => {
  const { stream, snapshot, base } = await server(t, { faultDelayMs: 2 });
  const response = await events(await stream(1, '你好', { fault: 'network' }));
  assert.equal(response.at(-1).error.code, 'DEMO_CONNECTION_LOST');
  assert.equal((await snapshot()).state.turnCount, 0);
  const metrics = await fetch(`${base}/api/metrics`).then((res) => res.json());
  assert.equal(metrics.errors, 1);
  assert.ok(metrics.recent.some((request) => request.code === 'DEMO_CONNECTION_LOST'));
  assert.ok(metrics.recent.every((request) => request.path.startsWith('/api/')));
  assert.ok(metrics.recent.every((request) => typeof request.requestId === 'string'));
});

test('TTS forwards the first audio bytes before the provider finishes', async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const fetcher = async () => new Response(new ReadableStream({ async start(controller) { controller.enqueue(new Uint8Array([73, 68, 51])); await gate; controller.enqueue(new Uint8Array([1, 2, 3])); controller.close(); } }), { headers: { 'Content-Type': 'audio/mpeg' } });
  const { post } = await server(t, { env: { SCENE_VOICE_API_KEY: 'voice-private' }, fetcher });
  const response = await post('/api/tts/stream', { text: '你好。' });
  assert.equal(response.headers.get('content-type'), 'audio/mpeg');
  assert.ok(Number(response.headers.get('x-audio-first-byte-ms')) >= 0);
  const reader = response.body.getReader();
  assert.deepEqual([...((await reader.read()).value)], [73, 68, 51]);
  release();
  assert.deepEqual([...((await reader.read()).value)], [1, 2, 3]);
  assert.equal((await reader.read()).done, true);
});

test('aborting a playing speech stream aborts the upstream audio request', async (t) => {
  let upstreamAborted = false;
  const fetcher = async (_url, options) => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([73, 68, 51]));
      options.signal.addEventListener('abort', () => { upstreamAborted = true; controller.error(new DOMException('Aborted', 'AbortError')); }, { once: true });
    },
  }), { headers: { 'Content-Type': 'audio/mpeg' } });
  const { post } = await server(t, { env: { SCENE_VOICE_API_KEY: 'voice-private' }, fetcher });
  const controller = new AbortController();
  const response = await post('/api/tts/stream', { text: '你好。' }, controller.signal);
  const reader = response.body.getReader();
  await reader.read();
  controller.abort();
  await assert.rejects(reader.read(), { name: 'AbortError' });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(upstreamAborted, true);
});

test('stream provider deadline emits a recoverable timeout without committing unseen lines', async (t) => {
  const fetcher = (_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }));
  const { stream, snapshot } = await server(t, { env: { SCENE_API_KEY: 'private', SCENE_TIMEOUT_MS: '15' }, fetcher });
  const result = await events(await stream(1, '看照片', { mode: 'live' }));
  assert.equal(result.at(-1).error.code, 'MODEL_TIMEOUT');
  assert.equal(result.at(-1).error.retryable, true);
  assert.equal((await snapshot()).state.photoShown, false);
});
