import { copyFile, mkdir, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const target = new URL('../public/vad/', import.meta.url);
await mkdir(target, { recursive: true });
const vad = new URL('../node_modules/@ricky0123/vad-web/dist/', import.meta.url);
const ort = new URL('../node_modules/onnxruntime-web/dist/', import.meta.url);
for (const file of ['silero_vad_v5.onnx', 'vad.worklet.bundle.min.js']) await copyFile(new URL(file, vad), new URL(file, target));
for (const file of await readdir(ort)) {
  if (/^ort-wasm.*\.(wasm|mjs)$/.test(file) && !file.includes('jsep')) await copyFile(new URL(file, ort), new URL(file, target));
}
console.log(`Prepared local VAD model, worklet and ONNX WASM assets at ${fileURLToPath(target)}.`);
