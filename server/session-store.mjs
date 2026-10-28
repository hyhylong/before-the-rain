import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { sessionIdSchema } from './protocol.mjs';

export class SessionStore extends Map {
  constructor(directory = false) {
    super();
    this.directory = directory ? path.resolve(directory) : false;
    if (!this.directory) return;
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    for (const file of readdirSync(this.directory)) {
      if (!file.endsWith('.json')) continue;
      const id = file.slice(0, -5);
      if (!sessionIdSchema.safeParse(id).success) continue;
      try {
        const value = JSON.parse(readFileSync(path.join(this.directory, file), 'utf8'));
        if (!value.state || !Array.isArray(value.history) || !Number.isSafeInteger(value.lastTurnId) || !Number.isFinite(value.updatedAt)) continue;
        this.set(id, { ...value, controller: null });
      } catch { /* A damaged session is isolated; other sessions remain recoverable. */ }
    }
  }

  save(id) {
    if (!this.directory || !this.has(id)) return;
    const { controller: _controller, ...record } = this.get(id);
    const file = path.join(this.directory, `${id}.json`);
    const temporary = path.join(this.directory, `${id}.${randomUUID()}.tmp`);
    writeFileSync(temporary, JSON.stringify(record), { mode: 0o600 });
    renameSync(temporary, file);
  }

  delete(id) {
    if (this.directory) {
      try { unlinkSync(path.join(this.directory, `${id}.json`)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return super.delete(id);
  }
}
