import { test, expect } from '@playwright/test';

async function ready(page) {
  await page.goto('/');
  await expect(page.locator('canvas')).toBeVisible();
  await expect(page.getByText('咖啡馆的灯亮着', { exact: true })).toHaveCount(0);
}
async function send(page, text) {
  await page.getByRole('textbox', { name: '对 Mira 说点什么' }).fill(text);
  await page.getByRole('button', { name: '发送', exact: true }).click();
}
async function trackAudio(page) {
  await page.addInitScript(() => {
    window.__audios = [];
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function (...args) {
      if (!window.__audios.includes(this)) window.__audios.push(this);
      return play.apply(this, args);
    };
  });
}
const allPaused = (page) => page.evaluate(() => window.__audios.every((audio) => audio.paused));

test('真实画布、中文录音、照片与雨停由当前交流驱动', async ({ page }) => {
  await trackAudio(page);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await ready(page);
  await send(page, '你好');
  await expect(page.getByTestId('experience')).toHaveAttribute('data-status', 'speaking');
  await expect.poll(() => page.evaluate(() => window.__audios.some((audio) => !audio.paused && audio.currentTime > 0))).toBe(true);
  await send(page, '可以看看你的相机吗？');
  await expect(page.getByRole('dialog', { name: 'Mira 的一张底片' })).toBeVisible({ timeout: 20000 });
  const image = page.getByRole('img', { name: '粉色晨光下，海岸灯塔亮着微弱的灯，海浪拍打礁石。' });
  await expect(image).toBeVisible();
  expect(await image.evaluate((node) => node.complete && node.naturalWidth > 100)).toBe(true);
  await send(page, '外面雨停了，我们走吧');
  await expect(page.getByTestId('experience')).toHaveAttribute('data-weather', 'clearing');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: '打断回复', exact: true }).click();
  await expect(page.getByTestId('experience')).toHaveAttribute('data-status', 'idle');
  expect(await allPaused(page)).toBe(true);
  expect(errors).toEqual([]);
});

test('迟到的照片回复不能覆盖新输入或弹出旧媒体', async ({ page }) => {
  let release;
  let received;
  const firstReady = new Promise((resolve) => { received = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  let first = true;
  await page.route('**/api/turn/stream', async (route) => {
    if (!first) return route.continue();
    first = false;
    const response = await route.fetch();
    received();
    await gate;
    await route.fulfill({ response }).catch(() => {});
  });
  await ready(page);
  await send(page, '给我看看照片');
  await firstReady;
  await send(page, '一起喝杯热咖啡');
  await expect(page.getByTestId('experience')).toHaveAttribute('data-status', 'speaking');
  release();
  await page.waitForTimeout(900);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByTestId('experience')).toHaveAttribute('data-weather', 'rain');
  await expect(page.getByTestId('subtitle')).toContainText('来一点热的吧');
});

test('说话中点击麦克风立即停止声音，识别新输入并忽略旧回调', async ({ page }) => {
  await trackAudio(page);
  await page.addInitScript(() => {
    window.__recognizers = [];
    window.SpeechRecognition = class {
      constructor() { window.__recognizers.push(this); }
      start() { this.started = true; }
      stop() { this.onend?.(); }
      abort() { this.aborted = true; }
    };
  });
  await ready(page);
  await send(page, '你在等谁');
  await expect(page.getByTestId('experience')).toHaveAttribute('data-status', 'speaking');
  await page.getByRole('button', { name: '打断并开始语音' }).click();
  await expect(page.getByTestId('experience')).toHaveAttribute('data-status', 'listening');
  expect(await allPaused(page)).toBe(true);
  await page.evaluate(() => {
    const instance = window.__recognizers.at(-1);
    window.__lateResult = instance.onresult;
    instance.onresult({ results: [[{ transcript: '雨停了，出去吧' }]] });
    instance.onend();
  });
  await expect(page.getByTestId('experience')).toHaveAttribute('data-weather', 'clearing');
  await page.evaluate(() => window.__lateResult({ results: [[{ transcript: '给我照片' }]] }));
  await expect(page.getByRole('textbox')).toHaveValue('');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('断线保留原输入可重试，重置后回放开场而非旧剧情', async ({ page }) => {
  await ready(page);
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('combobox', { name: '下次连接', exact: true }).selectOption('network');
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await send(page, '热茶');
  await expect(page.getByRole('alert')).toContainText('连接暂时中断');
  await page.getByRole('button', { name: '再试一次', exact: true }).click();
  await expect(page.getByTestId('experience')).toHaveAttribute('data-status', 'speaking');
  await expect(page.getByTestId('subtitle')).toContainText('来一点热的吧');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '重新相遇' }).click();
  await expect(page.getByTestId('subtitle')).toContainText('雨这么大');
  await page.getByRole('button', { name: '重听这段话' }).click();
  await expect(page.getByTestId('subtitle')).toContainText('雨这么大');
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('语音识别不可用和图片加载失败均有可操作的反馈', async ({ page }) => {
  await page.addInitScript(() => { window.SpeechRecognition = undefined; window.webkitSpeechRecognition = undefined; });
  await ready(page);
  await page.getByRole('button', { name: '开始语音输入' }).click();
  await expect(page.getByRole('status')).toContainText('当前浏览器没有语音识别服务');
  await expect(page.getByTestId('experience')).toHaveAttribute('data-status', 'idle');
  await page.route('**/images/lighthouse.png', (route) => route.abort());
  await send(page, '看看相机');
  await expect(page.getByText('底片暂时没有显影。')).toBeVisible({ timeout: 20000 });
  await page.unroute('**/images/lighthouse.png');
  await page.getByRole('button', { name: '重新加载' }).click();
  await expect(page.getByRole('dialog').locator('img')).toBeVisible();
});

test('桌面和两种手机尺寸无横向溢出，画布非空且持续运动', async ({ page }) => {
  for (const [width, height] of [[1440, 900], [390, 844], [320, 740]]) {
    await page.setViewportSize({ width, height });
    await ready(page);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const composer = await page.locator('.composer').boundingBox();
    expect(composer.x).toBeGreaterThanOrEqual(0);
    expect(composer.y + composer.height).toBeLessThanOrEqual(height);
    const canvas = page.locator('canvas');
    const before = await canvas.screenshot();
    const colorCount = await page.evaluate(async (source) => {
      const image = new Image(); image.src = source; await image.decode();
      const surface = document.createElement('canvas'); surface.width = 80; surface.height = 80;
      const context = surface.getContext('2d'); context.drawImage(image, 0, 0, 80, 80);
      const data = context.getImageData(0, 0, 80, 80).data;
      const colors = new Set();
      for (let i = 0; i < data.length; i += 4) colors.add(`${data[i] >> 4},${data[i + 1] >> 4},${data[i + 2] >> 4}`);
      return colors.size;
    }, `data:image/png;base64,${before.toString('base64')}`);
    expect(colorCount).toBeGreaterThan(35);
    await page.waitForTimeout(250);
    const after = await canvas.screenshot();
    expect(before.equals(after)).toBe(false);
  }
});
