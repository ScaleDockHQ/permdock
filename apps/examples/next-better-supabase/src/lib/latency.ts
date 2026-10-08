import { env } from "../env.ts";

/** Waits `DEMO_LATENCY_MS`, so a cached read is visibly instant next to a cold one. */
export async function latency(): Promise<void> {
  if (env.latencyMs === 0) {
    return;
  }
  await new Promise((resolve) => {
    setTimeout(resolve, env.latencyMs);
  });
}
