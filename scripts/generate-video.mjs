import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { CLIPS } from '../src/media/timeline.mjs';

await mkdir('public/video', { recursive: true });
await mkdir('artifacts/raw/clips', { recursive: true });
const browser = await chromium.launch({
  channel: 'chromium', headless: true,
  args: ['--no-sandbox', '--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader', '--autoplay-policy=no-user-gesture-required'],
});
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 });
  await page.routeWebSocket(/ws:\/\/localhost:4175.*/, (socket) => socket.close());
  await page.route('**/__capture.html', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><html><head><style>html,body,#capture-root{margin:0;width:100%;height:100%;overflow:hidden;background:#244b44}</style></head><body><div id="capture-root"></div><script type="module" src="/src/scene/CaptureEntry.jsx"></script></body></html>' }));
  await page.goto(`${process.env.CLIP_SOURCE_URL || 'http://localhost:4175'}/__capture.html`);
  const canvas = page.locator('[data-testid="scene-canvas"]');
  await canvas.waitFor();
  await page.waitForFunction(() => typeof document.querySelector('canvas')?.__capture === 'function');
  for (const kind of ['memory', 'rain']) {
    console.log(`Recording original ${kind} scene...`);
    const data = await page.evaluate(async (kind) => {
      const source = document.querySelector('[data-testid="scene-canvas"]');
      source.__direct({ status: 'idle', emotion: 'warm', gesture: kind === 'memory' ? 'showPhoto' : 'lookAway', weather: 'rain' });
      await new Promise((resolve) => setTimeout(resolve, 500));
      const image = new Image(); image.src = '/images/lighthouse.png'; await image.decode();
      const surface = document.createElement('canvas'); surface.width = 1280; surface.height = 800;
      const context = surface.getContext('2d');
      const stream = surface.captureStream(20);
      const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp8', videoBitsPerSecond: 2200000 });
      const chunks = [];
      const complete = new Promise((resolve) => { recorder.onstop = resolve; });
      recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      const started = performance.now();
      let frame;
      const draw = () => {
        const seconds = (performance.now() - started) / 1000;
        source.__capture();
        const zoom = kind === 'rain' ? 1 + seconds * 0.009 : 1 + Math.min(seconds, 3) * 0.018;
        context.drawImage(source, (1280 - 1280 * zoom) / 2, (800 - 800 * zoom) / 2, 1280 * zoom, 800 * zoom);
        if (kind === 'memory' && seconds > 2) {
          context.save(); context.globalAlpha = Math.min(1, (seconds - 2) / 1.5);
          const scale = Math.max(1280 / image.width, 800 / image.height) * (1 + Math.max(0, seconds - 3.5) * 0.012);
          context.drawImage(image, (1280 - image.width * scale) / 2, (800 - image.height * scale) / 2, image.width * scale, image.height * scale);
          context.restore();
        }
        if (kind === 'rain' && seconds > 2.1) source.__direct({ status: 'idle', emotion: 'warm', gesture: seconds > 6 ? 'wave' : 'lookAway', weather: 'clearing' });
        if (seconds < 8) frame = requestAnimationFrame(draw);
      };
      recorder.start(200); draw();
      await new Promise((resolve) => setTimeout(resolve, 8200));
      cancelAnimationFrame(frame); recorder.stop(); await complete;
      stream.getTracks().forEach((track) => track.stop());
      const blob = new Blob(chunks, { type: 'video/webm' });
      return await new Promise((resolve) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.readAsDataURL(blob); });
    }, kind);
    const raw = `artifacts/raw/clips/${kind}.webm`;
    await writeFile(raw, Buffer.from(data, 'base64'));
    execFileSync('ffmpeg', [
      '-y', '-v', 'error', '-i', raw, '-i', `public${CLIPS[kind].narration}`, '-f', 'lavfi', '-i', `anoisesrc=color=${kind === 'memory' ? 'pink' : 'brown'}:amplitude=0.025:sample_rate=24000:duration=8`,
      '-filter_complex', `[1:a]adelay=${CLIPS[kind].narrationDelayMs}|${CLIPS[kind].narrationDelayMs},apad,volume=1[narration];[2:a]afade=t=in:d=0.4,afade=t=out:st=6:d=2[ambient];[narration][ambient]amix=inputs=2:duration=longest,volume=2[audio]`,
      '-map', '0:v', '-map', '[audio]', '-vf', 'fps=24,format=yuv420p',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '25', '-threads', '3', '-c:a', 'aac', '-b:a', '64k', '-t', '8', '-movflags', '+faststart', `public/video/${kind}.mp4`,
    ], { stdio: ['ignore', 'ignore', 'pipe'] });
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-ss', '0.5', '-i', `public/video/${kind}.mp4`, '-frames:v', '1', '-q:v', '3', `public/video/${kind}.jpg`], { stdio: ['ignore', 'ignore', 'pipe'] });
    execFileSync('ffmpeg', ['-y', '-v', 'error', '-i', `public/video/${kind}.mp4`, '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-crf', '32', '-b:v', '0', '-pix_fmt', 'yuv420p', '-c:a', 'libopus', '-b:a', '48k', '-threads', '3', '-t', '8', `public/video/${kind}.webm`], { stdio: ['ignore', 'ignore', 'pipe'] });
  }
  execFileSync('ffmpeg', [
    '-y', '-v', 'error', '-f', 'lavfi', '-i', 'color=c=black@0.0:s=640x360:r=24:d=8,format=rgba',
    '-vf', "geq=r='210':g='230':b='230':a='lt(mod(X+Y*0.12+T*80,90),1.8)*lt(mod(Y+T*180,130),28)*100'",
    '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p', '-auto-alt-ref', '0', '-deadline', 'realtime', '-cpu-used', '8', '-threads', '2', '-an', 'public/video/rain-overlay.webm',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  await writeFile('public/video/manifest.json', JSON.stringify({ version: 2, origin: 'Original procedural Three.js Mira scene, original lighthouse illustration, existing Mandarin TTS narration and synthesized ambient noise. No generative AI video service.', clips: CLIPS, alphaOverlay: '/video/rain-overlay.webm' }, null, 2));
  console.log('Saved original memory/rain MP4s, alpha WebM, posters and manifest.');
} finally { await browser.close(); }
