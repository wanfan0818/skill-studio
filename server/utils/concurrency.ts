/**
 * Map with bounded concurrency, preserving input order in the result.
 * Filesystem-heavy scans are latency-bound (especially on cloud-synced
 * folders), so overlapping a handful of operations is a large win — but an
 * unbounded Promise.all over thousands of paths would exhaust file handles.
 */
export async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const idx = next++
      out[idx] = await fn(items[idx], idx)
    }
  })
  await Promise.all(workers)
  return out
}
