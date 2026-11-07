import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { getPermDockSync } from "../packages/permdock/src/core/permdock.ts";
import { snapshotFor } from "../packages/permdock/src/core/snapshot-for.ts";
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
} from "../packages/permdock/tests/bench/scale-matrix.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "scripts", "runtime-perf.json");
/** Wall-clock budget per measurement, after one warm-up call. */
const BUDGET_MS = 150;
const MIN_RUNS = 3;

type Timing = { readonly medianMs: number; readonly runs: number };

function measure(work: () => unknown, minRuns = MIN_RUNS): Timing {
  work();
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

async function measureAsync(
  work: () => Promise<unknown>,
  minRuns = MIN_RUNS,
): Promise<Timing> {
  await work();
  const samples: number[] = [];
  const started = performance.now();
  while (
    samples.length < minRuns ||
    (performance.now() - started < BUDGET_MS && samples.length < 200)
  ) {
    const at = performance.now();
    await work();
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
for (const memberCount of memberships) {
  for (const roleCount of roleTiers) {
    for (const customCount of customTiers) {
      const key = `m${String(memberCount)}-r${String(roleCount)}-c${String(customCount)}`;
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
      process.stdout.write(`${key} ${JSON.stringify(row["can"])}\n`);
    }
  }
}

const record = {
  node: process.version,
  platform: `${process.platform}-${process.arch}`,
  recordedAt: new Date().toISOString(),
  quick: ONLY,
  toolCount: TOOL_COUNT,
  filterRows: FILTER_ROWS,
  decideIds: DECIDE_IDS,
  capMs: CAP_MS,
  note: "filter100k, mayUse300 and decideIds1000 stop at capMs and state how many rows, tools or ids they covered. medianMs per call; keys are memberships (m), declared-plus-custom roles per membership (r) and custom roles per tenant (c). Run on the commit named in the PR; branch fixes later re-record.",
  cells,
};
if (process.argv.includes("--write")) {
  writeFileSync(OUT, `${JSON.stringify(record, null, 2)}\n`);
  process.stdout.write(`wrote ${OUT}\n`);
}
