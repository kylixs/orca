/**
 * Runs `task` over `items` with at most `limit` promises in flight.
 *
 * Returns one settled result per item, in input order, so a caller can decide
 * per-slot policy instead of failing the whole batch on one rejection.
 */
export async function boundedParallelMap<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  const concurrency = Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : 1
  const results: PromiseSettledResult<R>[] = []
  let nextIndex = 0

  const worker = async (): Promise<void> => {
    while (nextIndex < items.length) {
      const index = nextIndex
      nextIndex += 1
      try {
        results[index] = { status: 'fulfilled', value: await task(items[index], index) }
      } catch (reason) {
        results[index] = { status: 'rejected', reason }
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker))
  return results
}
