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
export declare function isPerfEnabled(): boolean;
export declare function createPerfStore(): PerfStore;
export declare function runWithPerf<T>(store: PerfStore, fn: () => T): T;
export declare function runWithoutPerf<T>(fn: () => T): T;
export declare function getPerfStore(): PerfStore | null;
export declare function addDbQuerySample(sample: PerfQuerySample, slowThresholdMs: number): void;
export declare function span<T>(name: string, fn: () => Promise<T>): Promise<T>;
//# sourceMappingURL=perf.d.ts.map