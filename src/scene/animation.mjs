import { z } from 'zod';

const poseSchema = z.object({
  headYaw: z.number().min(-1).max(1).default(0),
  headPitch: z.number().min(-0.5).max(0.5).default(0),
  headRoll: z.number().min(-0.5).max(0.5).default(0),
  rightArmX: z.number().min(-3).max(3).default(-0.10),
  rightArmZ: z.number().min(-3).max(3).default(-0.06),
  leftArmX: z.number().min(-3).max(3).default(-0.045),
  leftArmZ: z.number().min(-3).max(3).default(-0.13),
  elbowX: z.number().min(-2).max(1).default(-0.24),
  photo: z.boolean().default(false),
}).strict();
const actionSchema = z.object({ priority: z.number().int().min(0).max(100), blendSeconds: z.number().min(0.03).max(2), pose: poseSchema }).strict();
const localAsset = z.string().regex(/^\/[a-zA-Z0-9/_\-.]+$/);
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const characterSchema = z.object({
  version: z.literal(1),
  identity: z.object({ name: z.string().min(1).max(30), age: z.number().int().min(18).max(100) }).strict(),
  palette: z.object({ skin: color, hair: color, coat: color, collar: color }).strict(),
  resources: z.object({ photo: localAsset, memoryVideo: localAsset, rainVideo: localAsset }).strict(),
  idle: z.object({ breath: z.number().min(0).max(0.05), gaze: z.number().min(0).max(0.1), blinkSeconds: z.number().min(1).max(10) }).strict(),
  actions: z.object({ idle: actionSchema, nod: actionSchema, lookAway: actionSchema, showPhoto: actionSchema, wave: actionSchema, listening: actionSchema, thinking: actionSchema }).strict(),
}).strict();

const neutral = { headYaw: 0, headPitch: 0, headRoll: 0, rightArmX: -0.10, rightArmZ: -0.06, leftArmX: -0.045, leftArmZ: -0.13, elbowX: -0.24, photo: false };
export const DEFAULT_CHARACTER = characterSchema.parse({
  version: 1,
  identity: { name: 'Mira', age: 26 },
  palette: { skin: '#e7bca8', hair: '#302b2a', coat: '#d7a24f', collar: '#efc883' },
  resources: { photo: '/images/lighthouse.png', memoryVideo: '/video/memory.webm', rainVideo: '/video/rain.webm' },
  idle: { breath: 0.009, gaze: 0.035, blinkSeconds: 3.6 },
  actions: {
    idle: { priority: 0, blendSeconds: 0.22, pose: neutral },
    nod: { priority: 30, blendSeconds: 0.20, pose: { ...neutral, headPitch: 0.025 } },
    lookAway: { priority: 35, blendSeconds: 0.32, pose: { ...neutral, headYaw: -0.34 } },
    showPhoto: { priority: 60, blendSeconds: 0.34, pose: { ...neutral, rightArmX: -1.08, rightArmZ: -0.22, elbowX: -1.07, photo: true } },
    wave: { priority: 50, blendSeconds: 0.30, pose: { ...neutral, leftArmX: 0, leftArmZ: -2.12 } },
    listening: { priority: 100, blendSeconds: 0.09, pose: { ...neutral, headPitch: -0.04, headRoll: 0.075 } },
    thinking: { priority: 90, blendSeconds: 0.20, pose: { ...neutral, headYaw: -0.28 } },
  },
});

export class ActionScheduler {
  constructor(config = DEFAULT_CHARACTER) {
    this.configure(config);
    this.actions = new Map();
    this.epoch = 0;
    this.lastInput = '';
    this.current = 'idle';
  }

  configure(config) { this.config = characterSchema.parse(config); }

  request(id, name, { epoch = this.epoch, priority, expires = Infinity } = {}) {
    const action = this.config.actions[name];
    if (!action || epoch !== this.epoch) return false;
    this.actions.set(id, { name, epoch, expires, priority: priority ?? action.priority });
    return true;
  }

  cancel() { this.epoch += 1; this.actions.clear(); this.lastInput = ''; this.current = 'idle'; }

  update({ status = 'idle', gesture = 'idle' }, now = 0) {
    const key = `${status}:${gesture}`;
    if (key !== this.lastInput) {
      this.cancel();
      this.lastInput = key;
      this.request('gesture', gesture);
      if (status === 'listening' || status === 'thinking') this.request('state', status);
    }
    for (const [id, action] of this.actions) if (action.epoch !== this.epoch || action.expires <= now) this.actions.delete(id);
    const selected = [...this.actions.values()].sort((a, b) => b.priority - a.priority)[0];
    this.current = selected?.name || 'idle';
    return { name: this.current, ...this.config.actions[this.current], epoch: this.epoch };
  }
}

export class EmotionMixer {
  weights = { curious: 1, guarded: 0, warm: 0, melancholy: 0 };
  step(emotion, dt) {
    const smoothing = 1 - Math.exp(-Math.max(0, dt) * 5);
    for (const name of Object.keys(this.weights)) this.weights[name] += ((name === emotion ? 1 : 0) - this.weights[name]) * smoothing;
    return this.weights;
  }
}

const damp = (value, target, speed, dt) => value + (target - value) * (1 - Math.exp(-dt * speed));
const ease = (value) => { const t = Math.max(0, Math.min(1, value)); return t * t * (3 - 2 * t); };

export class PresenceMotion {
  seed = 361;
  nextGaze = 1.2;
  nextShift = 3.8;
  nextBlink = 2.4;
  blinkStart = -10;
  blinkAgain = false;
  gazeX = 0;
  gazeY = 0;
  headX = 0;
  headY = 0;
  targetGazeX = 0.1;
  targetGazeY = 0;
  shift = 0;
  targetShift = -0.12;
  audio = 0;
  action = 'idle';
  actionStart = 0;

  random() {
    this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0;
    return this.seed / 4294967296;
  }

  step(now, dt, { action = 'idle', level = 0, listening = false, blinkSeconds = 3.6 } = {}) {
    if (this.action !== action) { this.action = action; this.actionStart = now; }
    if (now > this.nextGaze) {
      this.targetGazeX = (this.random() - 0.5) * (listening ? 0.35 : 1.2);
      this.targetGazeY = (this.random() - 0.5) * 0.45;
      this.nextGaze = now + 1.6 + this.random() * 3.3;
    }
    if (now > this.nextShift) {
      this.targetShift = (this.random() - 0.5) * 0.8;
      this.nextShift = now + 5 + this.random() * 6;
    }
    if (now > this.nextBlink) {
      this.blinkStart = now;
      const doubleBlink = !this.blinkAgain && this.random() > 0.88;
      this.nextBlink = now + (doubleBlink ? 0.31 : blinkSeconds * (0.78 + this.random() * 0.9));
      this.blinkAgain = doubleBlink;
    }
    this.gazeX = damp(this.gazeX, this.targetGazeX, 12, dt);
    this.gazeY = damp(this.gazeY, this.targetGazeY, 10, dt);
    this.headX = damp(this.headX, this.gazeX, 1.7, dt);
    this.headY = damp(this.headY, this.gazeY, 1.3, dt);
    this.shift = damp(this.shift, this.targetShift, 0.65, dt);
    this.audio = damp(this.audio, level, level > this.audio ? 9 : 4, dt);
    const blink = (delay) => {
      const age = now - this.blinkStart - delay;
      if (age < 0 || age > 0.23) return 1;
      return age < 0.065 ? 1 - ease(age / 0.065) * 0.98 : 0.02 + ease((age - 0.085) / 0.145) * 0.98;
    };
    const age = Math.max(0, now - this.actionStart);
    return {
      breath: Math.sin(now * 1.25) * 0.75 + Math.sin(now * 0.61 + 1.2) * 0.25,
      shift: this.shift, gazeX: this.gazeX, gazeY: this.gazeY,
      headYaw: this.headX, headPitch: this.headY,
      blinkLeft: blink(0), blinkRight: blink(0.012), audio: this.audio, age,
      nod: age < 1.05 ? Math.sin(age / 1.05 * Math.PI * 2) * Math.sin(age / 1.05 * Math.PI) * 0.065 : 0,
      wave: ease(age / 0.45) * (1 - ease((age - 1.8) / 0.8)),
    };
  }
}

export function mouthShape(viseme, level) {
  const clamp = (value) => Math.max(0, Math.min(1, Number(value) || 0));
  const amplitude = clamp(level);
  const aa = clamp(viseme?.aa ?? amplitude);
  const ee = clamp(viseme?.ee);
  const oo = clamp(viseme?.oo);
  const closed = clamp(viseme?.closed);
  const gate = amplitude * (1 - closed);
  return {
    width: 0.085 + ee * 0.041 - oo * 0.034,
    height: 0.006 + gate * (0.018 + aa * 0.065 + oo * 0.04),
    roundness: oo,
  };
}
