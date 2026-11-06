import { availableParallelism } from "node:os";

/**
 * How many tasks may run at once. `1` runs them one at a time. Workers stay
 * off: a cold generate of the CentraKit-size fixture is 159 ms, and starting a
 * worker costs more than the emit it would save on that fixture.
 */
export function concurrencyOf(flag: number | undefined): number {
  if (flag !== undefined && flag > 0) {
    return flag;
  }
  return Math.max(1, availableParallelism() - 1);
}

/**
 * Runs `fn` over `items` with at most `limit` in flight. Results keep input
 * order whatever the scheduling.
 */
export async function mapLimited<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<readonly R[]> {
  const results: R[] = [];
  let next = 0;
  const workers = Math.max(
    1,
    Math.min(limit, items.length === 0 ? 1 : items.length),
  );
  async function run(): Promise<void> {
    for (;;) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item === undefined) {
        return;
      }
      results[index] = await fn(item, index);
    }
  }
  await Promise.all(Array.from({ length: workers }, () => run()));
  return results;
}
