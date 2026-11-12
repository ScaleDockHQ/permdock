import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { PermDock } from "../../src/core/permdock.ts";

import { mayUseOf } from "../../src/core/may-use.ts";
import { getPermDockSync } from "../../src/core/permdock.ts";
import { snapshotFor } from "../../src/core/snapshot-for.ts";
import { compareCell } from "./runtime-gate.ts";
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

/** Measurements of one cell `--check` takes before it fails the cell. */
const ATTEMPTS = 3;
const CHECK = process.argv.includes("--check");
const ONLY = process.argv.includes("--quick") || CHECK;
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
  if (process.argv.includes("--write") && !CHECK) {
    writeFileSync(OUT, `${JSON.stringify(record, null, 2)}\n`);
  }
};

async function measureCell(
  memberCount: number,
  roleCount: number,
  customCount: number,
): Promise<Record<string, unknown>> {
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
    instance.decideIds(permissions.item.read, part, { data: () => loaded }),
  );
  const customRoles = customRolesFor(memberCount, customCount);
  const snapshot = snapshotFor(policy, user, { tenant, customRoles });
  row["snapshotFor"] = measure(
    () => snapshotFor(policy, user, { tenant, customRoles }),
    1,
  );
  row["snapshotBytes"] = JSON.stringify(snapshot).length;
  return row;
}

type Baseline = {
  readonly node?: string;
  readonly platform?: string;
  readonly cells?: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
};

function readBaseline(): Baseline {
  const parsed: unknown = JSON.parse(readFileSync(OUT, "utf8"));
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("PermDock: scripts/runtime-perf.json is not an object");
  }
  // SAFETY: this script writes the file in this shape.
  return parsed as Baseline;
}

/**
 * `--check`: runs the quick matrix cells the committed baseline measured and
 * fails above its margin. A cell the baseline skipped, or lacks, stays
 * skipped.
 */
/** One pass over every tool permission through `mayUseOf`, in milliseconds. */
function mayUseTime(permdock: PermDock): number {
  const mayUse = mayUseOf(permdock);
  const asked = toolPermissions();
  const started = performance.now();
  const used = asked.filter((permission) => mayUse(permission));
  if (used.length !== asked.length) {
    throw new Error(
      `PermDock: mayUse granted ${String(used.length)} of ${String(asked.length)} tools`,
    );
  }
  return performance.now() - started;
}

/**
 * The expanded view must beat the wire snapshot on a subject with 150
 * memberships of 20 roles. Best of `ATTEMPTS` passes, so one noisy pass does
 * not fail the gate.
 */
function checkMayUseView(): string | undefined {
  const base = getPermDockSync(policy, userFor(150, 20, 0), {
    tenant: tenantId(0),
  });
  let direct = Infinity;
  let wire = Infinity;
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    // A spread copy drops the expanded view, so its first mayUse reads `snapshot()`.
    wire = Math.min(wire, mayUseTime({ ...base }));
    direct = Math.min(direct, mayUseTime(base));
  }
  process.stdout.write(
    `mayUse view: direct ${direct.toFixed(1)} ms, wire ${wire.toFixed(1)} ms\n`,
  );
  return direct < wire
    ? undefined
    : `mayUse on the expanded view (${direct.toFixed(1)} ms) is not faster than through the wire snapshot (${wire.toFixed(1)} ms)`;
}

async function check(): Promise<void> {
  const baseline = readBaseline();
  const sameMachine =
    baseline.platform === `${process.platform}-${process.arch}` &&
    baseline.node?.split(".")[0] === process.version.split(".")[0];
  const failures: string[] = [];
  for (const memberCount of memberships) {
    for (const roleCount of roleTiers) {
      for (const customCount of customTiers) {
        const key = `m${String(memberCount)}-r${String(roleCount)}-c${String(customCount)}`;
        const recorded = baseline.cells?.[key];
        if (recorded === undefined || "skipped" in recorded) {
          process.stdout.write(
            `${key} skipped: not measured in the baseline\n`,
          );
          continue;
        }
        // A noisy neighbour slows one run; a regression slows every run.
        let verdict = compareCell(
          key,
          recorded,
          await measureCell(memberCount, roleCount, customCount),
          sameMachine,
        );
        for (
          let attempt = 1;
          attempt < ATTEMPTS && verdict.failures.length > 0;
          attempt += 1
        ) {
          verdict = compareCell(
            key,
            recorded,
            await measureCell(memberCount, roleCount, customCount),
            sameMachine,
          );
        }
        failures.push(...verdict.failures);
        for (const note of verdict.notes) {
          process.stdout.write(`note: ${note}\n`);
        }
        process.stdout.write(
          `${key} ${verdict.failures.length === 0 ? "ok" : "over"}\n`,
        );
      }
    }
  }
  const viewFailure = checkMayUseView();
  if (viewFailure !== undefined) {
    failures.push(viewFailure);
  }
  if (!sameMachine) {
    process.stdout.write(
      `timings are notes: the baseline was recorded on ${baseline.platform ?? "?"} ${baseline.node ?? "?"}, this is ${process.platform}-${process.arch} ${process.version}\n`,
    );
  }
  if (failures.length > 0) {
    process.stderr.write(`${failures.join("\n")}\n`);
    process.exitCode = 1;
  }
}

async function run(): Promise<void> {
  if (CHECK) {
    await check();
    return;
  }
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
        const row = await measureCell(memberCount, roleCount, customCount);
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
    process.stdout.write(CHECK ? "checked\n" : `done ${OUT}\n`);
  })
  .catch((error: unknown) => {
    throw error;
  });
