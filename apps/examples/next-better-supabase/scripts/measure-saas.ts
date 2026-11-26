/**
 * Pages, persona JWTs and proxy on/off that the five-route checkpoint skipped.
 * Writes `checkpoints.after.saas` and leaves the five-route numbers in place.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import path from "node:path";

import { extraRoutes, saasRoutes } from "../perf/routes.ts";
import { measureSeed } from "./measure-collect.ts";
import { measureOff } from "./measure-off.ts";
import { writeReport } from "./measure-pr.ts";
import { loadBaseline } from "./measure-report.ts";
import { withServe } from "./measure.ts";

const sampleRoot = path.join(import.meta.dirname, "..");
const repoRoot = path.join(sampleRoot, "../../..");
const baselineFile = path.join(sampleRoot, "perf/baseline.json");
const reportFile = path.join(sampleRoot, "perf/report.md");
const rawDir = path.join(sampleRoot, "perf/raw");

const recorded = new Set([
  "quote-detail",
  "approvals",
  "member-admin",
  "settings",
  "access",
]);

const listed = [
  ...extraRoutes.filter((route) => !recorded.has(route.name)),
  ...saasRoutes,
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function commit(): string {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
}

function remember(saas: unknown): void {
  const baseline = loadBaseline(baselineFile);
  const checkpoints = isRecord(baseline["checkpoints"])
    ? baseline["checkpoints"]
    : {};
  const after = isRecord(checkpoints["after"]) ? checkpoints["after"] : {};
  writeFileSync(
    baselineFile,
    `${JSON.stringify(
      {
        ...baseline,
        checkpoints: { ...checkpoints, after: { ...after, saas } },
      },
      null,
      2,
    )}\n`,
  );
  writeReport(baselineFile, reportFile);
}

async function measurePages(
  only: string,
): Promise<{ readonly pages: unknown; readonly proxyOn: unknown }> {
  let pages: unknown = null;
  let proxyOn: unknown = null;
  await withServe("1000", "3489", {}, async (base, databaseUrl) => {
    pages = await measureSeed({
      base,
      seed: "1000",
      databaseUrl,
      runs: "5",
      session: "perf-saas-1000",
      rawDir,
      includeNew: true,
      listed,
      only,
    });
    proxyOn = await measureOff({ base, databaseUrl, runs: 50 });
  });
  return { pages, proxyOn };
}

async function main(): Promise<void> {
  const only = listed.map((route) => route.name).join(",");
  const { pages, proxyOn } = await measurePages(only);
  let proxyOff: unknown = null;
  await withServe(
    "1000",
    "3489",
    { MEASURE_WITHOUT: "proxy" },
    async (base, databaseUrl) => {
      proxyOff = await measureOff({ base, databaseUrl, runs: 50 });
    },
  );
  remember({
    commit: commit(),
    measuredAt: new Date().toISOString(),
    node: process.version,
    seed: 1000,
    pages,
    proxyOn,
    proxyOff,
  });
}

await main();
