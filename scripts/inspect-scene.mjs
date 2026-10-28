import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

const out = new URL('../artifacts/screenshots/', import.meta.url);
await mkdir(out, { recursive: true });
const browser = await chromium.launch({
  headless: true,
  channel: 'chromium',
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const issues = [];
for (const [name, width, height] of [['desktop', 1440, 900], ['mobile', 390, 844], ['small-mobile', 320, 740]]) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  page.on('pageerror', (error) => issues.push({ name, error: error.message }));
  await page.route('https://fonts.googleapis.com/**', (route) => route.abort());
  await page.goto(process.env.DEMO_URL || 'http://localhost:4173', { waitUntil: 'domcontentloaded' });
  await page.locator('[data-testid="scene-canvas"]').waitFor();
  await page.waitForTimeout(1600);
  const file = new URL(`${name}.png`, out);
  const screenshot = await page.screenshot({ path: file.pathname, fullPage: true });
  await page.waitForTimeout(450);
  const nextFrame = await page.screenshot({ fullPage: true });
  const { pixelVariance, motionDelta } = await page.evaluate(async ({ png, nextPng, width, height }) => {
    const photo = new Image(); photo.src = `data:image/png;base64,${png}`; await photo.decode();
    const sample = document.createElement('canvas'); sample.width = 64; sample.height = 64;
    const context = sample.getContext('2d');
    context.drawImage(photo, width * .32, height * .2, width * .4, height * .33, 0, 0, 64, 64);
    const { data } = context.getImageData(0, 0, 64, 64);
    const pixelVariance = [0, 1, 2].map((channel) => {
      let sum = 0; let squares = 0;
      for (let i = channel; i < data.length; i += 4) { sum += data[i]; squares += data[i] ** 2; }
      return Math.sqrt(squares / 4096 - (sum / 4096) ** 2);
    });
    const next = new Image(); next.src = `data:image/png;base64,${nextPng}`; await next.decode();
    context.drawImage(next, width * .32, height * .2, width * .4, height * .33, 0, 0, 64, 64);
    const after = context.getImageData(0, 0, 64, 64).data;
    let motion = 0;
    for (let i = 0; i < data.length; i++) if (i % 4 !== 3) motion += Math.abs(data[i] - after[i]);
    return { pixelVariance, motionDelta: motion / (4096 * 3) };
  }, { png: screenshot.toString('base64'), nextPng: nextFrame.toString('base64'), width, height });
  const dimension = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, viewport: innerWidth, canvas: document.querySelector('canvas')?.getBoundingClientRect().toJSON() }));
  console.log(JSON.stringify({ name, file: file.pathname, dimension, pixelVariance, motionDelta }));
  await page.close();
}
console.log(JSON.stringify({ issues }));
await browser.close();
