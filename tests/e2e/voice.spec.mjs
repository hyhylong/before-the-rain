import { test, expect } from '@playwright/test';

test('麦克风授权尚未返回时结束输入，迟到的音频轨道立即关闭且不提交识别', async ({ page }) => {
  let transcriptions = 0;
  await page.route('**/api/health', (route) => route.fulfill({ json: { liveAvailable: false, sttAvailable: true, ttsAvailable: false } }));
  await page.route('**/api/stt', (route) => {
    transcriptions += 1;
    return route.fulfill({ status: 503, json: { error: { message: 'Unexpected transcription request' } } });
  });
  await page.addInitScript(() => {
    window.SpeechRecognition = undefined; window.webkitSpeechRecognition = undefined;
    window.__pendingVoice = { requests: 0, stoppedTracks: 0, recorderCreations: 0 };
    const devices = navigator.mediaDevices || {};
    Object.defineProperty(devices, 'getUserMedia', { configurable: true, value: () => {
      window.__pendingVoice.requests += 1;
      return new Promise((resolve) => {
        window.__resolveMicrophone = () => resolve({ getTracks: () => [{ stop() { window.__pendingVoice.stoppedTracks += 1; } }] });
      });
    } });
    if (!navigator.mediaDevices) Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: devices });
    window.MediaRecorder = class { constructor() { window.__pendingVoice.recorderCreations += 1; } };
  });
  const healthLoaded = page.waitForResponse((response) => response.url().endsWith('/api/health'));
  await page.goto('/');
  await healthLoaded;
  await expect(page.getByTestId('scene-canvas')).toBeVisible();
  await page.getByRole('button', { name: '开始语音输入', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__pendingVoice.requests)).toBe(1);
  await expect(page.getByTestId('experience')).toHaveAttribute('data-status', 'listening');
  await page.getByRole('button', { name: '结束语音输入', exact: true }).click();
  await expect(page.getByTestId('experience')).toHaveAttribute('data-status', 'idle');
  await page.evaluate(() => window.__resolveMicrophone());
  await expect.poll(() => page.evaluate(() => window.__pendingVoice.stoppedTracks)).toBe(1);
  expect(await page.evaluate(() => window.__pendingVoice.recorderCreations)).toBe(0);
  await expect(page.getByTestId('experience')).toHaveAttribute('data-status', 'idle');
  await expect(page.getByRole('button', { name: '开始语音输入', exact: true })).toBeVisible();
  expect(transcriptions).toBe(0);
});
