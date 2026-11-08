import { writeFileSync } from "node:fs";
import path from "node:path";

import { getPermDockSync } from "../../src/core/permdock.ts";
import { snapshotFor } from "../../src/core/snapshot-for.ts";
import {
  CUSTOM_ROLE_TIERS,
  DECIDE_IDS,
  FILTER_ROWS,
  MEMBERSHIP_TIERS,
  ROLE_TIERS,
  TOOL_COUNT,
  customRolesFor,
  permissions,
  policy,
  rowsFor,
  sourceFor,
  tenantId,
  toolPermissions,
  userFor,
} from "./scale-matrix.ts";

const ROOT = path.join(import.meta.dirname, "../../../..");
const OUT = path.join(ROOT, "scripts", "runtime-perf.json");
/** Wall-clock budget per measurement, after one warm-up call. */
const BUDGET_MS = 150;
const MIN_RUNS = 3;

type Timing = { readonly medianMs: number; readonly runs: number };

const SLOW_MS = 10_000;
const SKIP_ABOVE = 20_000;

function measure(work: () => unknown, minRuns = MIN_RUNS): Timing {
  const first = performance.now();
  work();
  if (performance.now() - first > SLOW_MS) {
    return { medianMs: Math.round(performance.now() - first), runs: 1 };
  }
  const samples: number[] = [];
  const started = performance.now();
  while (
    samples.length < minRuns ||
    (performance.now() - started < BUDGET_MS && samples.length < 200)
  ) {
    const at = performance.now();
    work();
    samples.push(performance.now() - at);
  }
  samples.sort((a, b) => a - b);
  const median = samples[Math.floor(samples.length / 2)] ?? 0;
  return { medianMs: Math.round(median * 1000) / 1000, runs: samples.length };
}

/** Wall-clock cap for one slow operation; the record states how much it covered. */
const CAP_MS = 5000;

function capped<T>(
  items: readonly T[],
  chunk: number,
  work: (part: readonly T[]) => unknown,
): { readonly measured: number; readonly totalMs: number } {
  const started = performance.now();
  let measured = 0;
  while (measured < items.length && performance.now() - started < CAP_MS) {
    work(items.slice(measured, measured + chunk));
    measured += Math.min(chunk, items.length - measured);
  }
  return {
    measured,
    totalMs: Math.round((performance.now() - started) * 1000) / 1000,
  };
}

async function cappedAsync<T>(
  items: readonly T[],
  chunk: number,
  work: (part: readonly T[]) => Promise<unknown>,
): Promise<{ readonly measured: number; readonly totalMs: number }> {
  const started = performance.now();
  let measured = 0;
  while (measured < items.length && performance.now() - started < CAP_MS) {
    await work(items.slice(measured, measured + chunk));
    measured += Math.min(chunk, items.length - measured);
  }
  return {
    measured,
    totalMs: Math.round((performance.now() - started) * 1000) / 1000,
  };
}

const ONLY = process.argv.includes("--quick");
const memberships = ONLY ? [1, 150] : MEMBERSHIP_TIERS;
const roleTiers = ONLY ? [1, 20] : ROLE_TIERS;
const customTiers = ONLY ? [0, 500] : CUSTOM_ROLE_TIERS;

const filterRows = rowsFor(FILTER_ROWS, tenantId(0));
const ids = Array.from(
  { length: DECIDE_IDS },
  (_, index) => `i${String(index)}`,
);
const loaded = new Map(
  rowsFor(DECIDE_IDS, tenantId(0)).map((row) => [row.id, row]),
);
const tools = toolPermissions();

const cells: Record<string, unknown> = {};
let flush: () => void = () => undefined;
const record = {
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  recordedAt: new Date().toISOString(),
  quick: ONLY,
  toolCount: TOOL_COUNT,
  filterRows: FILTER_ROWS,
  decideIds: DECIDE_IDS,
  capMs: CAP_MS,
  note: "filter100k, mayUse300 and decideIds1000 stop at capMs and state how many rows, tools or ids they covered. A measurement whose first call took over 10 s runs once (runs: 1). medianMs per call; keys are memberships (m), roles per membership (r) and custom roles per tenant (c). Cells missing from the file were not reached.",
  cells,
};
flush = (): void => {
  if (process.argv.includes("--write")) {
    writeFileSync(OUT, `${JSON.stringify(record, null, 2)}\n`);
  }
};

async function run(): Promise<void> {
  for (const memberCount of memberships) {
    for (const roleCount of roleTiers) {
      for (const customCount of customTiers) {
        const key = `m${String(memberCount)}-r${String(roleCount)}-c${String(customCount)}`;
        if (memberCount * customCount > SKIP_ABOVE) {
          cells[key] = {
            skipped: `memberships × custom roles over ${String(SKIP_ABOVE)}: one probe of this size ran longer than 100 minutes without finishing`,
          };
          flush();
          continue;
        }
        const user = userFor(memberCount, roleCount, customCount);
        const tenant = tenantId(0);
        const source = sourceFor(memberCount, customCount);
        const build = () =>
          getPermDockSync(policy, user, { tenant, customRoles: source });
        const instance = build();
        const own = { id: "i0", orgId: tenant, ownerId: "u-scale" };
        const row: Record<string, unknown> = {};
        row["instanceBuild"] = measure(build);
        row["can"] = measure(() => instance.can(permissions.item.update, own));
        row["filter100k"] = capped(filterRows, 5000, (part) =>
          instance.filter(permissions.item.update, part),
        );
        row["where"] = measure(() => instance.where(permissions.item.update));
        row["mayUse300"] = capped(tools, 1, ([permission]) =>
          permission === undefined ? false : instance.mayUse(permission),
        );
        row["decideIds1000"] = await cappedAsync(ids, 25, (part) =>
          instance.decideIds(permissions.item.read, part, {
            data: () => loaded,
            trusted: true,
          }),
        );
        const customRoles = customRolesFor(memberCount, customCount);
        const snapshot = snapshotFor(policy, user, { tenant, customRoles });
        row["snapshotFor"] = measure(
          () => snapshotFor(policy, user, { tenant, customRoles }),
          1,
        );
        row["snapshotBytes"] = JSON.stringify(snapshot).length;
        cells[key] = row;
        process.stdout.write(
          `${key} ${JSON.stringify(row["instanceBuild"])}\n`,
        );
        flush();
      }
    }
  }
}

// Top-level await is banned for this package; a promise chain keeps the module loadable with require(esm).
// oxlint-disable-next-line unicorn/prefer-top-level-await
run()
  .then(() => {
    flush();
    process.stdout.write(`done ${OUT}\n`);
  })
  .catch((error: unknown) => {
    throw error;
  });
