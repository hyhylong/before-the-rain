import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { muxDemo } from './mux-demo.mjs';

const baseURL = process.env.DEMO_URL || 'http://localhost:4173';
await mkdir('artifacts/raw', { recursive: true });
const browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, recordVideo: { dir: 'artifacts/raw', size: { width: 1280, height: 800 } } });
await context.addInitScript(() => {
  window.__recordedAudio = [];
  const original = HTMLMediaElement.prototype.play;
  HTMLMediaElement.prototype.play = function (...args) {
    if (!this.__tracked) {
      this.__tracked = true;
      let entry;
      this.addEventListener('playing', () => {
        entry = { url: this.currentSrc || this.src, start: Date.now(), end: null, offset: this.currentTime, elapsed: 0, gain: this.muted ? 0 : this.volume };
        this.__recordingEntry = entry;
        window.__recordedAudio.push(entry);
      });
      const finish = () => { if (entry && !entry.end) { entry.end = Date.now(); entry.elapsed = this.currentTime - entry.offset; } };
      this.addEventListener('pause', finish);
      this.addEventListener('ended', finish);
    }
    return original.apply(this, args);
  };
  const originalPause = HTMLMediaElement.prototype.pause;
  HTMLMediaElement.prototype.pause = function (...args) {
    const entry = this.__recordingEntry;
    if (entry && !entry.end) { entry.end = Date.now(); entry.elapsed = this.currentTime - entry.offset; }
    return originalPause.apply(this, args);
  };
});
const page = await context.newPage();
const startedAt = Date.now();
const timeline = [];
const mark = (label) => { timeline.push({ seconds: Math.round((Date.now() - startedAt) / 1000), label }); console.log(label); };
const pause = (ms) => page.waitForTimeout(ms);
async function waitIdle() { await page.waitForFunction(() => document.querySelector('[data-testid="experience"]')?.dataset.status === 'idle', undefined, { timeout: 65000 }); }
async function send(text) {
  const input = page.getByRole('textbox', { name: '对 Mira 说点什么' });
  await input.fill(text); await pause(1800);
  await page.getByRole('button', { name: '发送', exact: true }).click();
  await page.waitForFunction(() => ['speaking', 'idle'].includes(document.querySelector('[data-testid="experience"]')?.dataset.status), undefined, { timeout: 20000 });
}
try {
  await page.goto(baseURL);
  await page.waitForSelector('canvas');
  await pause(2000);
  mark('开场：雨夜咖啡馆与中文语音');
  await page.getByRole('button', { name: '重听这段话' }).click();
  await waitIdle(); await pause(1000);
  await send('你好，我可以坐在这里吗？'); await waitIdle(); await pause(1800);
  mark('人物情绪：等待妹妹的约定');
  await send('这么晚了，你在等谁？'); await waitIdle(); await pause(1800);
  mark('对话触发：举照片、快门与灯塔插画');
  await send('我可以看看你的相机和照片吗？');
  await page.getByRole('dialog', { name: 'Mira 的一张底片' }).waitFor({ timeout: 25000 });
  await pause(7000);
  await page.getByRole('button', { name: '把照片还给她' }).click();
  await waitIdle(); await pause(1500);
  mark('成功打断：角色说话中立即停止，改聊新的话题');
  await send('说说你的下一次旅行吧'); await pause(3000);
  await page.getByRole('button', { name: '打断回复', exact: true }).click();
  await pause(1000);
  await send('没关系，我可以陪你等一会儿'); await waitIdle(); await pause(1600);
  mark('连续互动：热饮与陪伴');
  await send('要不要一起喝杯热咖啡？'); await waitIdle(); await pause(1600);
  await send('也许可以给妹妹打个电话，告诉她你在这里'); await waitIdle(); await pause(1800);
  mark('扩展：保留当前场景与会话诊断');
  await page.getByRole('button', { name: '拍下此刻', exact: true }).click();
  await page.getByRole('dialog', { name: '这一刻的留影' }).waitFor();
  await page.getByRole('dialog', { name: '这一刻的留影' }).locator('img').evaluate((image) => image.decode()); await pause(3000);
  await page.getByRole('dialog', { name: '这一刻的留影' }).getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '查看会话详情' }).click();
  await page.getByRole('tab', { name: '诊断', exact: true }).click(); await pause(3000);
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  mark('失败与恢复：模拟断线，原内容重试');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('combobox', { name: '下次连接', exact: true }).selectOption('network'); await pause(1800);
  await page.getByRole('button', { name: '关闭', exact: true }).click();
  await send('外面的雨好像停了，我们出去吧');
  await page.getByRole('alert').waitFor(); await pause(4500);
  await page.getByRole('button', { name: '再试一次', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-testid="experience"]')?.dataset.status === 'speaking');
  await waitIdle();
  mark('场景变化：雨停以后');
  const elapsed = Date.now() - startedAt;
  if (elapsed < 185000) await pause(185000 - elapsed);
  else await pause(5000);
  await page.getByRole('button', { name: '查看会话详情' }).click(); await pause(3500);
  await page.getByRole('button', { name: '关闭', exact: true }).click(); await pause(2000);
  const entries = await page.evaluate(() => window.__recordedAudio);
  const endTime = Date.now();
  const video = page.video();
  await context.close();
  const videoPath = await video.path();
  await browser.close();
  const duration = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', videoPath], { encoding: 'utf8' }).trim());
  const videoStart = endTime - duration * 1000;
  const tracks = entries.filter((entry) => /\/(audio|video)\/[a-zA-Z0-9_-]+\.(mp3|webm|mp4)$/.test(new URL(entry.url).pathname) && entry.elapsed > 0.05 && entry.gain > 0);
  if (!tracks.length) throw new Error('No actual audio playback was captured; refusing to export a silent demo.');
  const recording = { rawVideo: videoPath, duration, timeline, tracks: tracks.map((entry) => ({ asset: new URL(entry.url).pathname.slice(1), offset: entry.offset, gain: entry.gain, delayMs: Math.max(0, Math.round(entry.start - videoStart)), elapsed: entry.elapsed })) };
  await writeFile('artifacts/raw/recording.json', JSON.stringify(recording, null, 2));
  await muxDemo(recording);
} catch (error) {
  await context.close(); await browser.close(); throw error;
}
