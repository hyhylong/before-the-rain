import { z } from 'zod';

export const sessionIdSchema = z.string().min(1).max(80).regex(/^[a-zA-Z0-9_-]+$/);
export const turnRequestSchema = z.object({
  sessionId: sessionIdSchema,
  turnId: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  message: z.string().trim().min(1).max(1000),
  mode: z.enum(['mock', 'live']).default('mock'),
  fault: z.enum(['none', 'timeout', 'network']).default('none'),
}).strict();

export const lineSchema = z.object({
  text: z.string().trim().min(1).max(500),
  emotion: z.enum(['curious', 'guarded', 'warm', 'melancholy']),
  gesture: z.enum(['idle', 'nod', 'lookAway', 'showPhoto', 'wave']),
  scene: z.enum(['rain', 'clearing']).optional(),
  effect: z.enum(['shutter', 'lightning']).optional(),
  media: z.literal('photo').optional(),
  video: z.enum(['memory', 'rain']).optional(),
}).strict();

export const modelReplySchema = z.object({
  lines: z.array(lineSchema).min(1).max(5),
  choices: z.array(z.string().min(1).max(60)).min(1).max(3),
  chapter: z.string().min(1).max(50),
}).strict();

export const initialState = () => ({
  turnCount: 0,
  trust: 0,
  photoShown: false,
  backstoryKnown: false,
  scene: 'rain',
  ended: false,
});

export function applyDirectives(state, reply) {
  const next = { ...state, turnCount: state.turnCount + 1, trust: Math.min(8, state.trust + 1) };
  for (const line of reply.lines) {
    if (line.scene) next.scene = line.scene;
    if (line.media === 'photo') next.photoShown = true;
  }
  if (reply.chapter === '赴约的人') next.backstoryKnown = true;
  if (reply.chapter === '雨停以后') next.ended = true;
  return next;
}

export class SceneError extends Error {
  constructor(code, message, status = 500, retryable = false) {
    super(message);
    this.name = 'SceneError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}
