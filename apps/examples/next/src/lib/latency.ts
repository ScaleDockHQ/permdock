const DEFAULT_MS = 3000;

function latencyFrom(raw = ""): number {
  if (raw.trim() === "") {
    return DEFAULT_MS;
  }
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : DEFAULT_MS;
}

/**
 * Milliseconds every store read waits, so a cached read is visibly instant
 * next to a cold one. `DEMO_LATENCY_MS=0` turns it off.
 */
export const LATENCY_MS = latencyFrom(process.env["DEMO_LATENCY_MS"]);

export async function latency(): Promise<void> {
  if (LATENCY_MS === 0) {
    return;
  }
  await new Promise((resolve) => {
    setTimeout(resolve, LATENCY_MS);
  });
}
