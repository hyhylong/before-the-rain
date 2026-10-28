import { pinyin } from 'pinyin-pro';

const closed = () => ({ aa: 0, ee: 0, oo: 0, closed: 1 });

export function finalToViseme(final = '') {
  const value = final.toLowerCase().replace(/[1-5]/g, '');
  if (/^(m|p|b|f)$/.test(value)) return 'closed';
  if (/[ouüv]/.test(value) && !/a/.test(value)) return 'oo';
  if (/[iey]/.test(value) && !/a/.test(value)) return 'ee';
  return 'aa';
}

export function createVisemeTimeline(text, durationMs, boundaries) {
  const characters = Array.from(text);
  const finals = characters.map((character) => pinyin(character, { toneType: 'none', pattern: 'final' }));
  const cues = [];
  const weights = characters.map((character) => /[，。！？、,.!?;；：:\s]/.test(character) ? 0.6 : 1);
  const total = weights.reduce((sum, value) => sum + value, 0) || 1;
  let position = 0;
  for (let index = 0; index < characters.length; index++) {
    const weight = weights[index];
    const boundary = boundaries?.find((item) => item.charIndex === index);
    const startMs = boundary?.startMs ?? position / total * durationMs;
    const endMs = boundary?.endMs ?? (position + weight) / total * durationMs;
    const punctuation = /[，。！？、,.!?;；：:\s]/.test(characters[index]);
    cues.push({ charIndex: index, startMs, endMs, shape: punctuation ? 'closed' : finalToViseme(finals[index] || characters[index]) });
    position += weight;
  }
  return cues;
}

export function visemeAt(timeline, timeMs, level = 1, source = 'estimated-pinyin') {
  const cue = timeline.find((item) => item.startMs <= timeMs && item.endMs > timeMs);
  if (!cue || cue.shape === 'closed' || level < 0.025) return { ...closed(), source };
  const progress = (timeMs - cue.startMs) / Math.max(1, cue.endMs - cue.startMs);
  const amount = Math.min(1, level * 2.5) * Math.sin(Math.PI * Math.min(1, progress / 0.8));
  return { ...closed(), closed: 1 - amount, [cue.shape]: amount, source };
}

export function rmsLevel(samples) {
  if (!samples?.length) return 0;
  let squares = 0;
  for (const value of samples) squares += value * value;
  return Math.min(1, Math.sqrt(squares / samples.length) * 5);
}
