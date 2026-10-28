export class CueTimeline {
  constructor(cues = []) {
    this.cues = cues.filter((cue) => Number.isFinite(cue.at) && cue.at >= 0).map((cue, index) => ({ ...cue, id: cue.id || `cue-${index}` })).sort((a, b) => a.at - b.at);
    this.fired = new Set();
    this.cancelled = false;
  }
  advance(time) {
    if (this.cancelled) return [];
    const ready = this.cues.filter((cue) => cue.at <= time && !this.fired.has(cue.id));
    ready.forEach((cue) => this.fired.add(cue.id));
    return ready;
  }
  seek(time) {
    if (this.cancelled) return [];
    this.fired = new Set(this.cues.filter((cue) => cue.at <= time).map((cue) => cue.id));
    return this.cues.filter((cue) => cue.at <= time).slice(-1);
  }
  cancel() { this.cancelled = true; this.fired.clear(); }
}

export const CLIPS = {
  memory: {
    src: '/video/memory.webm', fallbackSrc: '/video/memory.mp4', poster: '/video/memory.jpg', duration: 8,
    title: '海边的那一刻', narration: '/audio/33289d23ebef.mp3', narrationDelayMs: 350,
    timeline: [{ at: 0.35, text: '你还记得这张照片。' }, { at: 2.82, text: '这里没有地名，只有我们当时等到的第一缕光。' }, { at: 7.4, text: '' }],
  },
  rain: {
    src: '/video/rain.webm', fallbackSrc: '/video/rain.mp4', poster: '/video/rain.jpg', duration: 8,
    title: '雨停以后', narration: '/audio/114f3e794f68.mp3', narrationDelayMs: 350,
    timeline: [{ at: 0.35, text: '你看，玻璃上的雨线慢下来了。' }, { at: 3.83, text: '对面的路灯终于不再像一团散开的光。' }, { at: 7.65, text: '', effect: 'shutter' }],
  },
};
