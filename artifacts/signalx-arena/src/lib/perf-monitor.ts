
// ── SignalX AI Performance Monitor ───────────────────────────────────────────
// Singleton that tracks real FPS via requestAnimationFrame and exposes
// adaptive quality levels. Components subscribe to get notified on change.

export type Quality = 'high' | 'medium' | 'low';

export interface PerfSnapshot {
  fps: number;
  quality: Quality;
  tickMs: number;      // recommended tick interval for the given bot count
  reducedMotion: boolean;
}

class PerfMonitor {
  private fps = 60;
  private frameCount = 0;
  private lastMeasure = 0;
  private rafId: number | null = null;
  private prevQuality: Quality = 'high';
  private readonly subscribers = new Set<(snap: PerfSnapshot) => void>();

  // Call once on app mount
  start() {
    if (this.rafId !== null) return;
    this.lastMeasure = performance.now();
    const loop = (now: number) => {
      this.frameCount++;
      const elapsed = now - this.lastMeasure;
      if (elapsed >= 1000) {
        this.fps = Math.round((this.frameCount / elapsed) * 1000);
        this.frameCount = 0;
        this.lastMeasure = now;
        const snap = this.snapshot(100); // default 100 bots
        if (snap.quality !== this.prevQuality) {
          this.prevQuality = snap.quality;
          this.subscribers.forEach(fn => fn(snap));
        }
      }
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  stop() {
    if (this.rafId !== null) { cancelAnimationFrame(this.rafId); this.rafId = null; }
  }

  subscribe(fn: (snap: PerfSnapshot) => void): () => void {
    this.subscribers.add(fn);
    fn(this.snapshot(100)); // immediate call with current state
    return () => this.subscribers.delete(fn);
  }

  snapshot(botCount: number): PerfSnapshot {
    const quality: Quality = this.fps >= 50 ? 'high' : this.fps >= 30 ? 'medium' : 'low';
    const reducedMotion = quality !== 'high';
    let tickMs: number;
    if (quality === 'high')   tickMs = botCount > 100 ? 1200 : 800;
    else if (quality === 'medium') tickMs = botCount > 100 ? 2000 : 1400;
    else                      tickMs = botCount > 100 ? 3500 : 2500;
    return { fps: this.fps, quality, tickMs, reducedMotion };
  }

  getFps(): number { return this.fps; }
  getQuality(): Quality { return this.fps >= 50 ? 'high' : this.fps >= 30 ? 'medium' : 'low'; }
}

// Singleton
export const perfMonitor = new PerfMonitor();
