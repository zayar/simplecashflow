import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

export type PerfQuerySample = {
  ms: number;
  model?: string;
  operation?: string;
};

export type PerfStore = {
  requestId: string;
  startMs: number;
  dbMs: number;
  dbCount: number;
  slowQueries: PerfQuerySample[];
  spans: Record<string, number>;
};

const als = new AsyncLocalStorage<PerfStore>();

export function isPerfEnabled(): boolean {
  const v = String(process.env.PERF_LOG ?? '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes';
}

export function createPerfStore(): PerfStore {
  return {
    requestId: randomUUID(),
    startMs: performance.now(),
    dbMs: 0,
    dbCount: 0,
    slowQueries: [],
    spans: {},
  };
}

export function runWithPerf<T>(store: PerfStore, fn: () => T): T {
  return als.run(store, fn);
}

// Detach perf context for fire-and-forget background tasks spawned by a request.
// This avoids polluting request DB timings with async "after response" work.
export function runWithoutPerf<T>(fn: () => T): T {
  return (als as any).run(undefined, fn);
}

export function getPerfStore(): PerfStore | null {
  return als.getStore() ?? null;
}

export function addDbQuerySample(sample: PerfQuerySample, slowThresholdMs: number) {
  const store = getPerfStore();
  if (!store) return;
  store.dbMs += sample.ms;
  store.dbCount += 1;
  if (sample.ms >= slowThresholdMs) {
    store.slowQueries.push(sample);
    // keep bounded (avoid memory bloat)
    if (store.slowQueries.length > 25) store.slowQueries.shift();
  }
}

export function span<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const store = getPerfStore();
  if (!store) return fn();
  const t0 = performance.now();
  return fn().finally(() => {
    const dt = performance.now() - t0;
    store.spans[name] = (store.spans[name] ?? 0) + dt;
  });
}

