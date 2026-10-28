import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const journalKey = 'before-the-rain.session.v2';

async function ready(page) {
  await page.goto('/');
  await expect(page.getByTestId('scene-canvas')).toBeVisible();
  await expect(page.getByRole('button', { name: '拍下此刻', exact: true })).toBeEnabled();
}

async function send(page, text) {
  await page.getByRole('textbox', { name: '对 Mira 说点什么' }).fill(text);
  await page.getByRole('button', { name: '发送', exact: true }).click();
}

async function stopReply(page) {
  const stop = page.getByRole('button', { name: '打断回复', exact: true });
  if (await stop.isVisible()) await stop.click();
}

test('首句按独立流块播放，收到最终块后才出现后续选项', async ({ page }) => {
  const acknowledgements = [];
  await page.route('**/api/session/ack', async (route) => {
    const body = route.request().postDataJSON();
    acknowledgements.push(body);
    await route.fulfill({ json: { acknowledgedLine: body.lineIndex } });
  });
  await page.addInitScript(() => {
    const nativeFetch = window.fetch.bind(window);
    window.fetch = async (input, options) => {
      if (input !== '/api/turn/stream') return nativeFetch(input, options);
      const { turnId } = JSON.parse(options.body);
      const line = { text: '第一句话已经到了。', emotion: 'warm', gesture: 'nod' };
      const encode = (value) => new TextEncoder().encode(`${JSON.stringify(value)}\n`);
      window.__streamFinalSent = false;
      let finished = false;
      const body = new ReadableStream({
        start(controller) {
          controller.enqueue(encode({ type: 'line', turnId, replyId: 'browser-stream', index: 0, line }));
          window.__finishTurnStream = () => {
            if (finished) return;
            finished = true;
            window.__streamFinalSent = true;
            controller.enqueue(encode({ type: 'final', turnId, replyId: 'browser-stream', lines: [line], chapter: '逐句相遇', choices: ['下一句话'], timing: { firstLineMs: 5, totalMs: 1000 } }));
            controller.close();
          };
          options.signal.addEventListener('abort', () => {
            if (!finished) { finished = true; controller.error(new DOMException('Cancelled', 'AbortError')); }
          }, { once: true });
        },
      });
      return new Response(body, { headers: { 'Content-Type': 'application/x-ndjson' } });
    };
  });
  await ready(page);
  await send(page, '验证逐句回应');
  await expect(page.getByTestId('experience')).toHaveAttribute('data-status', 'speaking');
  await expect(page.getByTestId('subtitle')).toContainText('第一句话已经到了。');
  expect(await page.evaluate(() => window.__streamFinalSent)).toBe(false);
  expect(acknowledgements).toHaveLength(1);
  expect(acknowledgements[0].lineIndex).toBe(0);
  await expect(page.getByRole('button', { name: '下一句话', exact: true })).toHaveCount(0);
  await page.evaluate(() => window.__finishTurnStream());
  await expect(page.getByRole('button', { name: '下一句话', exact: true })).toBeVisible();
  await stopReply(page);
});

test('场景留影保存当前画布，图片有尺寸和实际像素', async ({ page }) => {
  await ready(page);
  await page.getByRole('button', { name: '拍下此刻', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '这一刻的留影' });
  await expect(dialog).toBeVisible();
  const image = dialog.getByRole('img', { name: 'Mira 与咖啡馆的当前场景留影' });
  const pixels = await image.evaluate(async (node) => {
    await node.decode();
    const canvas = document.createElement('canvas');
    canvas.width = 96; canvas.height = 54;
    const context = canvas.getContext('2d');
    context.drawImage(node, 0, 0, canvas.width, canvas.height);
    const data = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const colors = new Set();
    let opaque = 0;
    for (let i = 0; i < data.length; i += 4) {
      colors.add(`${data[i] >> 4},${data[i + 1] >> 4},${data[i + 2] >> 4}`);
      if (data[i + 3] > 128) opaque++;
    }
    return { width: node.naturalWidth, height: node.naturalHeight, colors: colors.size, opaque };
  });
  expect(pixels.width).toBe(1280);
  expect(pixels.height).toBe(720);
  expect(pixels.colors).toBeGreaterThan(35);
  expect(pixels.opaque).toBeGreaterThan(96 * 54 * 0.9);
  await expect(dialog.getByText('MIRA · 此时此刻', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('link', { name: '保存画面' })).toHaveAttribute('href', /\/api\/media\/assets\/.+\.png$/);
  await dialog.getByRole('button', { name: '关闭', exact: true }).click();
  await expect(dialog).toHaveCount(0);
});

test('本地剧情视频实际播放，新输入会卸载片段并停止旧播放器', async ({ page }) => {
  await ready(page);
  await page.getByRole('button', { name: '播放剧情片段', exact: true }).click();
  const stage = page.getByTestId('video-stage');
  const video = page.getByTestId('story-video');
  await expect(stage).toHaveAttribute('data-state', 'playing');
  await expect.poll(() => video.evaluate((node) => node.currentTime)).toBeGreaterThan(0.1);
  const oldVideo = await video.elementHandle();
  const frame = await video.evaluate((node) => {
    const canvas = document.createElement('canvas'); canvas.width = 80; canvas.height = 45;
    const context = canvas.getContext('2d'); context.drawImage(node, 0, 0, 80, 45);
    const pixels = context.getImageData(0, 0, 80, 45).data;
    const colors = new Set();
    for (let i = 0; i < pixels.length; i += 4) colors.add(`${pixels[i] >> 4},${pixels[i + 1] >> 4},${pixels[i + 2] >> 4}`);
    return { width: node.videoWidth, height: node.videoHeight, colors: colors.size };
  });
  expect(frame.width).toBeGreaterThanOrEqual(320);
  expect(frame.height).toBeGreaterThanOrEqual(180);
  expect(frame.colors).toBeGreaterThan(20);
  await send(page, '给你一杯热茶');
  await expect(stage).toHaveCount(0);
  expect(await oldVideo.evaluate((node) => node.paused && !node.getAttribute('src'))).toBe(true);
  await expect(page.getByTestId('subtitle')).toContainText('来一点热的吧');
  await stopReply(page);
});

test('创作任务可取消，明确失败后重试沿用参考画面并显示结果', async ({ page }) => {
  const requests = [];
  const cancelled = [];
  await page.route('**/api/media/capabilities', (route) => route.fulfill({ json: { imageAvailable: true, videoAvailable: true, counts: {} } }));
  await page.route('**/api/media/jobs**', async (route) => {
    const request = route.request();
    if (request.method() === 'DELETE') {
      cancelled.push(request.url().split('/').at(-1));
      return route.fulfill({ json: { status: 'cancelled' } });
    }
    if (request.method() === 'POST') requests.push(request.postDataJSON());
    const attempt = requests.length;
    const body = requests.at(-1);
    const job = { id: body.clientJobId, turnId: body.turnId, kind: 'image', source: 'generated', progress: 25, status: 'generating' };
    if (attempt === 2) Object.assign(job, { status: 'failed', error: { code: 'DEMO_FAILURE', message: '创作服务暂时忙，请重试。', retryable: true } });
    if (attempt >= 3) Object.assign(job, { status: 'ready', progress: 100, result: { url: '/images/lighthouse.png', source: 'generated' } });
    return route.fulfill({ json: job });
  });
  await ready(page);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: 'AI 创作', exact: true }).click();
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '创作剧情图片', exact: true }).click();
  await expect(page.getByTestId('media-job')).toContainText('正在创作');
  await expect.poll(() => requests.length).toBe(1);
  await page.getByRole('button', { name: '取消影像任务', exact: true }).click();
  await expect(page.getByTestId('media-job')).toHaveCount(0);
  await expect.poll(() => cancelled).toContain(requests[0].clientJobId);
  await page.getByRole('button', { name: '创作剧情图片', exact: true }).click();
  await expect(page.getByTestId('media-job')).toContainText('创作服务暂时忙，请重试。');
  await page.getByTestId('media-job').getByRole('button', { name: '再试一次', exact: true }).click();
  const result = page.getByRole('dialog', { name: 'Mira 的新画面' });
  await expect(result).toBeVisible();
  expect(requests).toHaveLength(3);
  expect(requests[2].reference).toBe(requests[1].reference);
  expect(requests[2].clientJobId).not.toBe(requests[1].clientJobId);
  expect(requests[2].mode).toBe('live');
  await expect(result.getByRole('img', { name: 'Mira 与咖啡馆的当前场景留影' })).toBeVisible();
  await result.getByRole('button', { name: '关闭', exact: true }).click();
});

test('刷新后找回服务端未说完的回复，继续上次不发送新轮次', async ({ page }) => {
  await ready(page);
  await send(page, '给你点一杯热咖啡吧');
  await expect(page.getByTestId('subtitle')).toContainText('来一点热的吧');
  await expect(page.getByTestId('experience')).toHaveAttribute('data-status', 'speaking');
  await expect.poll(() => page.evaluate((key) => JSON.parse(localStorage.getItem(key)).status, journalKey)).toBe('speaking');
  await page.reload();
  await expect(page.getByRole('button', { name: '继续上次', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: '继续上次', exact: true })).toBeVisible();
  let newTurns = 0;
  page.on('request', (request) => { if (request.url().endsWith('/api/turn/stream')) newTurns++; });
  await page.getByRole('button', { name: '继续上次', exact: true }).click();
  await expect(page.getByTestId('experience')).toHaveAttribute('data-status', 'speaking');
  await expect(page.getByTestId('subtitle')).toContainText('来一点热的吧');
  await expect(page.getByRole('button', { name: '我是来躲雨的', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '继续上次', exact: true })).toHaveCount(0);
  expect(newTurns).toBe(0);
  await stopReply(page);
});

test('会话可导出再导入，回放可停止且不会新增交流', async ({ page }) => {
  test.setTimeout(75000);
  await ready(page);
  await send(page, '我请你喝热咖啡');
  await expect(page.getByTestId('subtitle')).toContainText('来一点热的吧');
  await page.waitForTimeout(1250);
  await stopReply(page);
  await page.getByRole('button', { name: '查看会话详情', exact: true }).click();
  const details = page.getByRole('dialog', { name: '这一次相遇' });
  await expect(details.getByText('1 次交流', { exact: true })).toBeVisible();
  const downloadPromise = page.waitForEvent('download');
  await details.getByRole('button', { name: '导出会话', exact: true }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('before-the-rain-session.json');
  const exported = await readFile(await download.path());
  const record = JSON.parse(exported.toString());
  expect(record.version).toBe(2);
  expect(record.turns).toHaveLength(1);
  expect(record.turns[0].user).toBe('我请你喝热咖啡');
  expect(record.turns[0].played.length).toBeGreaterThan(0);
  await details.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '重新相遇' }).click();
  await page.getByRole('button', { name: '查看会话详情', exact: true }).click();
  await expect(details.getByText('0 次交流', { exact: true })).toBeVisible();
  await details.getByLabel('导入会话文件').setInputFiles({ name: 'session.json', mimeType: 'application/json', buffer: exported });
  await expect(details.getByText('1 次交流', { exact: true })).toBeVisible();
  await expect(details.getByText('我请你喝热咖啡', { exact: true })).toBeVisible();
  await details.getByRole('button', { name: '完整回放', exact: true }).click();
  await expect(details.getByRole('button', { name: '停止回放', exact: true })).toBeVisible();
  await details.getByRole('button', { name: '停止回放', exact: true }).click();
  await expect(page.getByTestId('experience')).toHaveAttribute('data-status', 'idle');
  await expect(details.getByRole('button', { name: '完整回放', exact: true })).toBeVisible();
  await expect(details.getByText('1 次交流', { exact: true })).toBeVisible();
  await details.getByRole('button', { name: '关闭', exact: true }).click();
});

test('诊断展示真实请求统计，事件和片段页可以切换', async ({ page }) => {
  await ready(page);
  await send(page, '你好');
  await expect(page.getByTestId('experience')).toHaveAttribute('data-status', 'speaking');
  await stopReply(page);
  await page.getByRole('button', { name: '查看会话详情', exact: true }).click();
  const details = page.getByRole('dialog', { name: '这一次相遇' });
  await details.getByRole('tab', { name: '诊断', exact: true }).click();
  await expect(details.getByRole('tab', { name: '诊断', exact: true })).toHaveAttribute('aria-selected', 'true');
  const diagnostics = details.getByTestId('diagnostics');
  await expect(diagnostics).toBeVisible();
  await expect(diagnostics).toContainText('首句 P50');
  await expect(diagnostics).toContainText('Token 输入 / 输出');
  await expect(diagnostics.getByLabel('最近请求')).toContainText('/api/turn/stream');
  await details.getByRole('tab', { name: '事件', exact: true }).click();
  await expect(details.getByLabel('会话事件')).toContainText('first-line');
  await details.getByRole('tab', { name: '片段', exact: true }).click();
  await expect(details.getByText('1 次交流', { exact: true })).toBeVisible();
});
