/**
 * Minimal metrics registry: named counters and gauges, snapshot on demand.
 * Deliberately no labels/histograms in v1 — names are dot-namespaced and the
 * whole registry serializes to JSON for /internal/metrics. When a real
 * collector arrives (OTel), this is the surface it scrapes or replaces.
 */

export interface MetricsSnapshot {
    counters: Record<string, number>;
    gauges: Record<string, number>;
}

export const createMetrics = () => {
    const counters = new Map<string, number>();
    const gauges = new Map<string, number>();

    return {
        counter: (name: string) => ({
            inc: (by = 1) => counters.set(name, (counters.get(name) ?? 0) + by),
            value: () => counters.get(name) ?? 0,
        }),
        gauge: (name: string) => ({
            set: (value: number) => gauges.set(name, value),
            value: () => gauges.get(name) ?? 0,
        }),
        snapshot: (): MetricsSnapshot => ({
            counters: Object.fromEntries(counters),
            gauges: Object.fromEntries(gauges),
        }),
        reset: () => {
            counters.clear();
            gauges.clear();
        },
    };
};

export type Metrics = ReturnType<typeof createMetrics>;

/** Process-wide default registry — apps import this one. */
export const metrics = createMetrics();
