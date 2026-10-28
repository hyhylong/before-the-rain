export class TurnScope {
  version = 0;
  controller = null;
  cleanups = new Set();

  next() {
    this.cancel();
    this.controller = new AbortController();
    return { id: this.version, signal: this.controller.signal };
  }

  current(id) {
    return id === this.version;
  }

  addCleanup(cleanup) {
    this.cleanups.add(cleanup);
    return () => this.cleanups.delete(cleanup);
  }

  cancel() {
    this.version += 1;
    this.controller?.abort();
    this.controller = null;
    for (const cleanup of this.cleanups) cleanup();
    this.cleanups.clear();
  }
}
