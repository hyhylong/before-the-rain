import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApp } from '../server/app.mjs';
import { modelReplySchema } from '../server/protocol.mjs';

async function server(t, options = {}) {
  const instance = createApp({ env: {}, mockDelayMs: 1, faultDelayMs: 5, ...options }).listen(0, '127.0.0.1');
  await once(instance, 'listening');
  t.after(() => { instance.closeAllConnections(); instance.close(); });
  const base = `http://127.0.0.1:${instance.address().port}`;
  const post = async (route, body) => {
    const response = await fetch(`${base}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const turn = (message, turnId, extra = {}) => post('/api/turn', { sessionId: 'test-session', turnId, message, mode: 'mock', ...extra });
  return { base, post, turn };
}

test('mock story triggers photograph and weather only through relevant dialogue', async (t) => {
  const { turn } = await server(t);
  const hello = await turn('你好', 1);
  assert.equal(hello.status, 200);
  assert.equal(hello.body.state.photoShown, false);
  assert.equal(hello.body.state.scene, 'rain');
  assert.ok(modelReplySchema.safeParse({ lines: hello.body.lines, choices: hello.body.choices, chapter: hello.body.chapter }).success);
  const photo = await turn('你的相机里有什么照片？', 2);
  assert.ok(photo.body.lines.some((item) => item.media === 'photo' && item.effect === 'shutter'));
  assert.equal(photo.body.state.photoShown, true);
  const waiting = await turn('你在等谁？', 3);
  assert.ok(waiting.body.lines.some((item) => item.emotion === 'melancholy'));
  assert.equal(waiting.body.state.backstoryKnown, true);
  const end = await turn('雨停了，我们走吧', 4);
  assert.equal(end.body.state.scene, 'clearing');
  assert.equal(end.body.state.ended, true);
  assert.equal(end.body.state.turnCount, 4);
});

test('invalid requests and deliberate failures do not advance story', async (t) => {
  const { turn } = await server(t);
  assert.equal((await turn(' '.repeat(4), 1)).status, 400);
  assert.equal((await turn('x'.repeat(1001), 1)).status, 400);
  const network = await turn('你好', 1, { fault: 'network' });
  assert.equal(network.status, 503);
  assert.equal(network.body.error.code, 'DEMO_CONNECTION_LOST');
  const timeout = await turn('你好', 2, { fault: 'timeout' });
  assert.equal(timeout.status, 504);
  assert.equal(timeout.body.error.code, 'DEMO_TIMEOUT');
  assert.equal((await turn('你好', 3)).body.state.turnCount, 1);
});

test('new turn cancels an older overlapping request and stale ids cannot commit', async (t) => {
  const { turn } = await server(t, { mockDelayMs: 80 });
  const older = turn('给我看照片', 1);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const newer = turn('喝茶吧', 2);
  const [oldResult, newResult] = await Promise.all([older, newer]);
  assert.equal(oldResult.status, 409);
  assert.equal(oldResult.body.error.code, 'TURN_CANCELLED');
  assert.equal(newResult.status, 200);
  assert.equal(newResult.body.state.turnCount, 1);
  assert.equal(newResult.body.state.photoShown, false);
  assert.equal((await turn('late stale request', 1)).status, 409);
});

test('client disconnect aborts pending work without committing its photograph event', async (t) => {
  const { base, turn } = await server(t, { mockDelayMs: 150 });
  const controller = new AbortController();
  const pending = fetch(`${base}/api/turn`, {
    method: 'POST', signal: controller.signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 'test-session', turnId: 1, message: '看照片', mode: 'mock' }),
  });
  const rejection = assert.rejects(pending, { name: 'AbortError' });
  await new Promise((resolve) => setTimeout(resolve, 30));
  controller.abort();
  await rejection;
  await new Promise((resolve) => setTimeout(resolve, 20));
  const next = await turn('你好', 2);
  assert.equal(next.body.state.turnCount, 1);
  assert.equal(next.body.state.photoShown, false);
});

test('reset removes narrative state and health only reveals capabilities', async (t) => {
  const { base, post, turn } = await server(t);
  await turn('看照片', 1);
  const reset = await post('/api/session/reset', { sessionId: 'test-session' });
  assert.equal(reset.body.state.photoShown, false);
  assert.equal((await turn('你好', 1)).body.state.turnCount, 1);
  const health = await fetch(`${base}/api/health`).then((res) => res.json());
  assert.deepEqual(health, { ok: true, liveAvailable: false, sttAvailable: false, ttsAvailable: false });
  const live = await turn('你好', 2, { mode: 'live' });
  assert.equal(live.body.error.code, 'LIVE_NOT_CONFIGURED');
});

test('live provider retries malformed structured replies without exposing credentials', async (t) => {
  let calls = 0;
  const fetcher = async (_url, options) => {
    assert.equal(options.headers.Authorization, 'Bearer test-private-value');
    assert.equal(Object.hasOwn(JSON.parse(options.body), 'thinking'), false);
    calls += 1;
    return new Response(JSON.stringify({ choices: [{ message: { content: calls === 1 ? 'not json' : JSON.stringify({ chapter: '窗边', lines: [{ text: '今晚的雨有一点大。', emotion: 'warm', gesture: 'nod' }], choices: ['坐一会儿'] }) } }] }), { status: 200 });
  };
  const { turn } = await server(t, { env: { SCENE_API_KEY: 'test-private-value', SCENE_API_BASE_URL: 'https://provider.invalid/v1' }, fetcher });
  const result = await turn('你好', 1, { mode: 'live' });
  assert.equal(calls, 2);
  assert.equal(result.status, 200);
  assert.ok(!JSON.stringify(result.body).includes('test-private-value'));
});

test('DeepSeek full replies use the configured endpoint, model and disabled thinking mode', async (t) => {
  const reply = { chapter: '窗边', lines: [{ text: '先坐一会儿吧，咖啡还温着。', emotion: 'warm', gesture: 'nod' }], choices: ['坐一会儿'] };
  const requests = [];
  const fetcher = async (url, options) => {
    requests.push({ url, method: options.method, body: JSON.parse(options.body) });
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }] }));
  };
  const { turn } = await server(t, {
    env: { SCENE_API_KEY: 'deepseek-test-only', SCENE_API_BASE_URL: 'https://api.deepseek.com/', SCENE_MODEL: 'deepseek-flash', SCENE_THINKING: 'disabled' },
    fetcher,
  });
  const result = await turn('你好', 1, { mode: 'live' });
  assert.equal(result.status, 200);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://api.deepseek.com/chat/completions');
  assert.equal(requests[0].method, 'POST');
  assert.equal(requests[0].body.model, 'deepseek-flash');
  assert.deepEqual(requests[0].body.thinking, { type: 'disabled' });
  assert.deepEqual(requests[0].body.messages.at(-1), { role: 'user', content: '你好' });
  assert.deepEqual(result.body.lines, reply.lines);
});

test('upstream timeout and failures produce recoverable errors', async (t) => {
  const fetcher = (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  });
  const { turn } = await server(t, { env: { SCENE_API_KEY: 'private', SCENE_TIMEOUT_MS: '15' }, fetcher });
  const response = await turn('你好', 1, { mode: 'live' });
  assert.equal(response.status, 504);
  assert.equal(response.body.error.code, 'MODEL_TIMEOUT');
  assert.equal(response.body.error.retryable, true);
});

test('malformed model output remains an explicit failure and never silently switches to mock', async (t) => {
  let calls = 0;
  const fetcher = async () => {
    calls += 1;
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"lines":[]}' } }] }));
  };
  const { turn } = await server(t, { env: { SCENE_API_KEY: 'private' }, fetcher });
  const response = await turn('你好', 1, { mode: 'live' });
  assert.equal(calls, 2);
  assert.equal(response.status, 502);
  assert.equal(response.body.error.code, 'INVALID_MODEL_REPLY');
  assert.equal(response.body.lines, undefined);
});

test('upstream HTTP bodies and thrown provider errors never leak private values', async (t) => {
  for (const failure of ['http', 'network']) {
    await t.test(failure, async (subtest) => {
      const privateValue = 'test-only-upstream-secret';
      const fetcher = async () => {
        if (failure === 'network') throw new Error(`Connection failed for key ${privateValue}`);
        return new Response(JSON.stringify({ error: { message: `Invalid credential ${privateValue}` } }), { status: 401 });
      };
      const { turn } = await server(subtest, { env: { SCENE_API_KEY: privateValue }, fetcher });
      const response = await turn('你好', 1, { mode: 'live' });
      assert.equal(response.status, failure === 'http' ? 502 : 500);
      assert.equal(response.body.error.retryable, true);
      assert.ok(!JSON.stringify(response.body).includes(privateValue));
      assert.ok(!JSON.stringify(response.body).includes('Connection failed'));
    });
  }
});
