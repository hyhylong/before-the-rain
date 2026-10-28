import { z } from 'zod';

export const JOURNAL_KEY = 'before-the-rain.session.v2';
const line = z.object({ text: z.string().min(1).max(500), emotion: z.enum(['curious', 'guarded', 'warm', 'melancholy']), gesture: z.enum(['idle', 'nod', 'lookAway', 'showPhoto', 'wave']), scene: z.enum(['rain', 'clearing']).optional(), effect: z.enum(['shutter', 'lightning']).optional(), media: z.literal('photo').optional(), video: z.enum(['memory', 'rain']).optional() }).strict();
const played = z.object({ line, index: z.number().int().min(0).max(4), durationMs: z.number().nonnegative().max(120000), complete: z.boolean() });
const turn = z.object({ id: z.number().int().nonnegative(), user: z.string().max(1000), chapter: z.string().max(50), timestamp: z.string().max(40), lines: z.array(line).max(5), played: z.array(played).max(5), choices: z.array(z.string().max(60)).max(3) });
export const journalSchema = z.object({ version: z.literal(2), sessionId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/), turnVersion: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER - 10000), mode: z.enum(['mock', 'live']), weather: z.enum(['rain', 'clearing']), emotion: z.enum(['curious', 'guarded', 'warm', 'melancholy']), subtitle: z.string().max(500), chapter: z.string().max(50), choices: z.array(z.string().max(60)).max(3), status: z.enum(['idle', 'listening', 'thinking', 'speaking']), turns: z.array(turn).max(100) });

export function readJournal() {
  try { const raw = localStorage.getItem(JOURNAL_KEY); return raw ? journalSchema.parse(JSON.parse(raw)) : null; } catch { return null; }
}
export function saveJournal(value) {
  try { localStorage.setItem(JOURNAL_KEY, JSON.stringify(value)); } catch { /* Private browsing or quota exhaustion leaves the live session usable. */ }
}
export function parseJournal(text) {
  if (text.length > 2 * 1024 * 1024) throw new Error('会话文件过大。');
  try { return journalSchema.parse(JSON.parse(text)); } catch { throw new Error('这不是有效的雨夜会话文件。'); }
}
