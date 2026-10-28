import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import express from 'express';
import { createApp } from './app.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
if (existsSync(path.join(root, '.env'))) process.loadEnvFile(path.join(root, '.env'));
const app = createApp({ dataDir: process.env.SCENE_DATA_DIR || path.join(root, '.data', 'sessions') });
app.use('/vad', express.static(path.join(root, 'public', 'vad')));
let vite;
if (existsSync(path.join(root, 'dist/index.html')) && process.env.NODE_ENV !== 'development') {
  app.use(express.static(path.join(root, 'dist')));
  app.get(/.*/, (_req, res) => res.sendFile(path.join(root, 'dist/index.html')));
} else {
  const { createServer } = await import('vite');
  vite = await createServer({ root, server: { middlewareMode: true }, appType: 'spa' });
  app.use(vite.middlewares);
}

const port = Number(process.env.PORT || 4173);
const server = app.listen(port, '0.0.0.0', () => {
  console.log(`Mira is waiting at http://localhost:${port}`);
});
server.on('error', (error) => {
  console.error(error.code === 'EADDRINUSE' ? `Port ${port} is in use. Start with PORT=<another-port> npm start.` : 'Unable to start the scene server.');
  process.exitCode = 1;
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await vite?.close();
    server.close(() => process.exit(0));
  });
}
