/**
 * The runtime matrix gate: compares a measured cell of `scale-runner.ts` with
 * the committed `scripts/runtime-perf.json`.
 */

/** Headroom over the baseline before a measurement fails. */
const MARGIN = 1.1;
/**
 * Added to a per-call limit, in ms: a call under 0.05 ms varies by more than
 * 10% between two runs on one machine.
 */
const NOISE_FLOOR_MS = 0.05;
/** The same floor per item of a capped measurement, in ms. */
const NOISE_FLOOR_PER_ITEM_MS = 0.001;

const PER_CALL = ["instanceBuild", "can", "where", "snapshotFor"] as const;
const CAPPED = ["filter100k", "mayUse300", "decideIds1000"] as const;

type Row = Readonly<Record<string, unknown>>;

export type Verdict = {
  /** A measurement over its limit, or a cell the baseline has and the run lacks. */
  readonly failures: readonly string[];
  /** Timings over their limit on a machine the baseline was not recorded on. */
  readonly notes: readonly string[];
};

function num(row: Row, key: string, field: string): number | undefined {
  const entry = row[key];
  if (typeof entry !== "object" || entry === null) {
    return undefined;
  }
  const value: unknown = Reflect.get(entry, field);
  return typeof value === "number" ? value : undefined;
}

function perItem(row: Row, key: string): number | undefined {
  const total = num(row, key, "totalMs");
  const measured = num(row, key, "measured");
  return total === undefined || measured === undefined || measured === 0
    ? undefined
    : total / measured;
}

/**
 * Compares one cell. `snapshotBytes` is deterministic and always enforced. The
 * timings are enforced when `sameMachine` is true; otherwise an excess is a
 * note, because a baseline recorded on another platform or Node major says
 * nothing about this one.
 */
export function compareCell(
  key: string,
  baseline: Row,
  current: Row,
  sameMachine: boolean,
): Verdict {
  const failures: string[] = [];
  const notes: string[] = [];
  const over = (message: string): void => {
    (sameMachine ? failures : notes).push(message);
  };
  const baseBytes = baseline["snapshotBytes"];
  const bytes = current["snapshotBytes"];
  if (
    typeof baseBytes === "number" &&
    typeof bytes === "number" &&
    bytes > baseBytes * MARGIN
  ) {
    failures.push(
      `${key} snapshotBytes ${String(bytes)} is over ${String(Math.floor(baseBytes * MARGIN))} (baseline ${String(baseBytes)} + 10%)`,
    );
  }
  for (const name of PER_CALL) {
    const base = num(baseline, name, "medianMs");
    const now = num(current, name, "medianMs");
    if (base !== undefined && now !== undefined) {
      const limit = base * MARGIN + NOISE_FLOOR_MS;
      if (now > limit) {
        over(
          `${key} ${name} ${String(now)} ms is over ${limit.toFixed(3)} ms (baseline ${String(base)} ms + 10% + ${String(NOISE_FLOOR_MS)} ms)`,
        );
      }
    }
  }
  for (const name of CAPPED) {
    const base = perItem(baseline, name);
    const now = perItem(current, name);
    if (base !== undefined && now !== undefined) {
      const limit = base * MARGIN + NOISE_FLOOR_PER_ITEM_MS;
      if (now > limit) {
        over(
          `${key} ${name} ${now.toFixed(4)} ms per item is over ${limit.toFixed(4)} ms (baseline ${base.toFixed(4)} ms + 10%)`,
        );
      }
    }
  }
  return { failures, notes };
}
