import test from 'node:test';
import assert from 'node:assert/strict';
import { LineQueue, readTurnStream } from '../src/stream.mjs';
import { JOURNAL_KEY, parseJournal, readJournal, saveJournal } from '../src/journal.mjs';

const encoder = new TextEncoder();
const dialogue = { text: '雨停了，灯塔还亮着。', emotion: 'warm', gesture: 'nod', scene: 'clearing', video: 'memory' };
const journal = () => ({
  version: 2, sessionId: 'recovery-fixture', turnVersion: 123, mode: 'mock', weather: 'clearing', emotion: 'warm',
  subtitle: dialogue.text, chapter: '灯塔', choices: ['继续'], status: 'idle',
  turns: [{ id: 122, user: '后来呢？', chapter: '灯塔', timestamp: '2026-10-27T00:00:00.000Z', lines: [dialogue], choices: ['继续'], played: [{ line: dialogue, index: 0, durationMs: 945, complete: false }] }],
});

function replaceStorage(t, value) {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value });
  t.after(() => original ? Object.defineProperty(globalThis, 'localStorage', original) : delete globalThis.localStorage);
}

test('stream decoder preserves Chinese and emoji split at every UTF-8 byte boundary', async () => {
  const first = { type: 'line', turnId: 8, index: 0, line: { ...dialogue, text: '窗外的雨声 🌧️' } };
  const final = { type: 'final', turnId: 8, lines: [first.line], choices: ['继续'], chapter: '窗边' };
  const bytes = encoder.encode(`\r\n${JSON.stringify(first)}\r\n\n${JSON.stringify(final)}`);
  const response = new Response(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(Uint8Array.of(byte)); controller.close(); } }));
  const received = [];
  await readTurnStream(response, (event) => received.push(event), new AbortController().signal);
  assert.deepEqual(received, [first, final]);
  assert.equal(response.body.locked, false);
});

test('stream decoder publishes a complete line while the remaining response is still pending', async () => {
  let source;
  const received = [];
  let publish;
  const published = new Promise((resolve) => { publish = resolve; });
  const response = new Response(new ReadableStream({ start(controller) { source = controller; } }));
  const decoding = readTurnStream(response, (event) => { received.push(event); publish(); }, new AbortController().signal);
  source.enqueue(encoder.encode(`${JSON.stringify({ type: 'line', turnId: 9, index: 0, line: dialogue })}\n`));
  await published;
  assert.equal(received.length, 1);
  source.enqueue(encoder.encode(`${JSON.stringify({ type: 'final', turnId: 9, lines: [dialogue] })}\n`)); source.close();
  await decoding;
  assert.equal(received.at(-1).type, 'final');
});

test('a disconnected text stream retains its delivered line and requests recovery', async () => {
  const received = [];
  const response = new Response(`${JSON.stringify({ type: 'line', turnId: 10, index: 0, line: dialogue })}\n`);
  await assert.rejects(readTurnStream(response, (event) => received.push(event), new AbortController().signal), /回复连接中断/);
  assert.equal(received.length, 1);
  assert.equal(received[0].line.text, dialogue.text);
  assert.equal(response.body.locked, false);
});

test('explicit provider errors are preserved and do not silently trigger connection recovery', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({
    start(controller) { controller.enqueue(encoder.encode(`${JSON.stringify({ type: 'error', error: { code: 'INVALID_MODEL_REPLY', message: '回复格式无效。' } })}\n`)); },
    cancel() { cancelled = true; },
  }));
  await assert.rejects(readTurnStream(response, () => assert.fail('Error frames cannot be played'), new AbortController().signal), (error) => error.message === '回复格式无效。' && error.retryConnection === false);
  assert.equal(cancelled, true);
  assert.equal(response.body.locked, false);
});

test('aborting a pending stream read cancels transport before any late event can be delivered', async () => {
  let source;
  let cancelled = false;
  const received = [];
  const controller = new AbortController();
  const response = new Response(new ReadableStream({ start(value) { source = value; }, cancel() { cancelled = true; } }));
  const decoding = readTurnStream(response, (event) => received.push(event), controller.signal);
  controller.abort();
  let timer;
  const result = await Promise.race([
    decoding.then(() => ({ completed: true }), (error) => ({ error })),
    new Promise((resolve) => { timer = setTimeout(() => resolve({ timedOut: true }), 50); }),
  ]);
  clearTimeout(timer);
  if (result.timedOut) { source.close(); await decoding.catch(() => {}); }
  assert.equal(result.timedOut, undefined, 'Cancellation must release the pending read without waiting for response bytes');
  assert.equal(result.error?.name, 'AbortError');
  assert.equal(cancelled, true);
  assert.deepEqual(received, []);
  assert.equal(response.body.locked, false);
});

test('failed queues discard unplayed cues and reject an already waiting consumer', async () => {
  const queue = new LineQueue();
  queue.push({ line: dialogue }); queue.fail(new Error('Turn invalidated'));
  await assert.rejects(async () => { for await (const _entry of queue) assert.fail('Invalidated cues cannot play'); }, /Turn invalidated/);
  const waiting = new LineQueue();
  const result = waiting[Symbol.asyncIterator]().next();
  waiting.fail(new Error('Connection lost'));
  await assert.rejects(result, /Connection lost/);
});

test('journal round trip preserves interrupted playback and rejects unsupported media directives', (t) => {
  const store = new Map();
  replaceStorage(t, { getItem: (key) => store.get(key) ?? null, setItem: (key, value) => store.set(key, value) });
  const snapshot = journal();
  saveJournal(snapshot);
  assert.deepEqual(readJournal(), snapshot);
  assert.deepEqual(parseJournal(store.get(JOURNAL_KEY)), snapshot);
  assert.equal(readJournal().turns[0].played[0].complete, false);
  const invalid = journal(); invalid.turns[0].lines[0] = { ...dialogue, media: 'https://unsafe.example/image.png' };
  assert.throws(() => parseJournal(JSON.stringify(invalid)), /有效的雨夜会话/);
  for (const turnVersion of [1e100, 123.5, Number.MAX_SAFE_INTEGER - 1]) {
    const corruptCounter = JSON.stringify({ ...journal(), turnVersion });
    assert.throws(() => parseJournal(corruptCounter), /有效的雨夜会话/);
    store.set(JOURNAL_KEY, corruptCounter);
    assert.equal(readJournal(), null);
  }
  assert.throws(() => parseJournal('x'.repeat(2 * 1024 * 1024 + 1)), /文件过大/);
});

test('corrupt journals and unavailable browser storage leave a live session usable', (t) => {
  replaceStorage(t, { getItem: () => '{broken', setItem: () => { throw new Error('Quota exceeded'); } });
  assert.equal(readJournal(), null);
  assert.doesNotThrow(() => saveJournal(journal()));
  assert.throws(() => parseJournal('{broken'), /有效的雨夜会话/);
});
