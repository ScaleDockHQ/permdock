import { latency } from "./latency.ts";

/**
 * An RLS read with when it ran and how long it took; a cache hit keeps both
 * from the run that filled it.
 */
export type Loaded<T> = {
  readonly value: T;
  /** Milliseconds since the epoch. */
  readonly loadedAt: number;
  readonly tookMs: number;
};

export async function timed<T>(read: () => Promise<T>): Promise<Loaded<T>> {
  const started = performance.now();
  await latency();
  const value = await read();
  return {
    value,
    loadedAt: Date.now(),
    tookMs: Math.round(performance.now() - started),
  };
}
