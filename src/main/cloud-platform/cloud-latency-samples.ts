/** Timing summary shared by the §5.1 latency budgets (M102–M104). */

export type LatencyStats = {
  samples: number
  p50: number
  p95: number
  min: number
  max: number
}

export function roundMs(value: number): number {
  return Math.round(value * 100) / 100
}

export function latencyStats(values: number[]): LatencyStats {
  const sorted = [...values].sort((a, b) => a - b)
  const at = (percent: number): number => {
    const index = Math.min(sorted.length - 1, Math.ceil((percent / 100) * sorted.length) - 1)
    return roundMs(sorted[Math.max(0, index)] ?? 0)
  }
  return {
    samples: sorted.length,
    p50: at(50),
    p95: at(95),
    min: roundMs(sorted[0] ?? 0),
    max: roundMs(sorted.at(-1) ?? 0)
  }
}

/** Throws instead of returning a verdict, so a control run can reuse the same check. */
export function assertLatencyBudget(label: string, stats: LatencyStats, budgetMs: number): void {
  if (stats.p95 > budgetMs) {
    throw new Error(`${label} P95 ${stats.p95}ms over budget ${budgetMs}ms`)
  }
}
