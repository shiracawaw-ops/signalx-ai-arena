
// ── usePerf hook ──────────────────────────────────────────────────────────────
// Subscribes to the global PerfMonitor and returns the current perf snapshot.
// Only triggers re-render when the QUALITY level changes (not every FPS tick),
// so it's safe to use in any component without causing excessive re-renders.

import { useState, useEffect, useCallback } from 'react';
import { perfMonitor, type Quality, type PerfSnapshot } from '@/lib/perf-monitor';

export { type Quality };

export function usePerf() {
  const [snap, setSnap] = useState<PerfSnapshot>(() => perfMonitor.snapshot(100));

  useEffect(() => {
    perfMonitor.start();
    const unsub = perfMonitor.subscribe(setSnap);
    return unsub;
  }, []);

  // Helper: should animations be reduced?
  const shouldReduceMotion = snap.quality !== 'high';

  // Returns tick delay appropriate for a given bot count
  const getTickMs = useCallback((botCount: number) => {
    return perfMonitor.snapshot(botCount).tickMs;
  }, [snap.quality]);

  return { ...snap, shouldReduceMotion, getTickMs };
}
