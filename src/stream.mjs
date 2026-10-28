export function abortableDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Cancelled', 'AbortError'));
    const abort = () => { clearTimeout(timer); reject(new DOMException('Cancelled', 'AbortError')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export class LineQueue {
  values = [];
  waiter = null;
  done = false;
  error = null;
  push(value) { if (this.done) return; this.values.push(value); this.wake(); }
  close() { this.done = true; this.wake(); }
  fail(error) { this.error = error; this.done = true; this.values = []; this.wake(); }
  wake() { this.waiter?.(); this.waiter = null; }
  async *[Symbol.asyncIterator]() {
    while (true) {
      if (this.error) throw this.error;
      if (this.values.length) yield this.values.shift();
      else if (this.done) return;
      else await new Promise((resolve) => { this.waiter = resolve; });
    }
  }
}

export async function readTurnStream(response, onEvent, signal) {
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error?.message || '连接暂时中断，请重试。');
  }
  if (!response.body) throw new Error('这个浏览器无法接收流式回复。');
  const reader = response.body.getReader();
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  const decoder = new TextDecoder();
  let pending = '';
  let final = false;
  const process = (line) => {
    if (!line.trim()) return;
    const event = JSON.parse(line);
    if (event.type === 'error') { const error = new Error(event.error?.message || '回复中断了，请重试。'); error.retryConnection = false; throw error; }
    if (event.type === 'final') final = true;
    onEvent(event);
  };
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      const { done, value } = await reader.read();
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      pending += decoder.decode(value, { stream: !done });
      if (pending.length > 128000) throw new Error('回复过长，请重新开始。');
      let end;
      while ((end = pending.indexOf('\n')) >= 0) { process(pending.slice(0, end)); pending = pending.slice(end + 1); }
      if (done) break;
    }
    if (pending.trim()) process(pending);
    if (!final) throw new Error('回复连接中断，正在尝试找回。');
  } finally { signal?.removeEventListener('abort', abort); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
