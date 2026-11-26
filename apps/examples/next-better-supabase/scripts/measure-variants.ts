/** Same-session before rebuild, and the off builds of the final checkpoint. */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { measureSeed } from "./measure-collect.ts";
import { measureOff } from "./measure-off.ts";
import { writeReport } from "./measure-pr.ts";
import { loadBaseline } from "./measure-report.ts";

const sampleRoot = path.join(import.meta.dirname, "..");
const repoRoot = path.join(sampleRoot, "../../..");
const baselineFile = path.join(sampleRoot, "perf/baseline.json");
const reportFile = path.join(sampleRoot, "perf/report.md");
const rawDir = path.join(sampleRoot, "perf/raw");

const VARIANTS = ["proxy", "may-access", "shared-cache", "warm"] as const;

export type Serve = (
  seed: string,
  port: string,
  extra: Readonly<Record<string, string | undefined>>,
  run: (base: string, databaseUrl: string | null) => Promise<void>,
  cwd?: string,
) => Promise<void>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function worktree(sha: string): string {
  const dir = path.join(os.tmpdir(), `permdock-before-${sha.slice(0, 12)}`);
  try {
    execFileSync("git", ["worktree", "remove", "--force", dir], {
      cwd: repoRoot,
      stdio: "ignore",
    });
  } catch {
    // The directory is not a worktree yet.
  }
  execFileSync("git", ["worktree", "add", "--detach", dir, sha], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  return dir;
}

function rememberBefore(measured: unknown, seed: string, sha: string): void {
  const baseline = loadBaseline(baselineFile);
  const previous = isRecord(baseline["sessionBefore"])
    ? baseline["sessionBefore"]
    : {};
  const seedsRecord = isRecord(previous["seeds"])
    ? { ...previous["seeds"] }
    : {};
  seedsRecord[seed] = measured;
  writeFileSync(
    baselineFile,
    `${JSON.stringify(
      {
        ...baseline,
        sessionBefore: {
          commit: sha,
          measuredAt: new Date().toISOString(),
          node: process.version,
          seeds: seedsRecord,
        },
      },
      null,
      2,
    )}\n`,
  );
  writeReport(baselineFile, reportFile);
}

async function beforeSeeds(
  sample: string,
  seeds: readonly string[],
  index: number,
  port: string,
  sha: string,
  runs: string,
  serve: Serve,
): Promise<void> {
  if (index >= seeds.length) {
    return;
  }
  const seed = seeds[index];
  await serve(
    seed,
    port,
    {},
    async (base, databaseUrl) => {
      rememberBefore(
        await measureSeed({
          base,
          seed,
          databaseUrl,
          runs,
          session: `perf-session-${seed}`,
          rawDir,
          includeNew: false,
        }),
        seed,
        sha,
      );
    },
    sample,
  );
  await beforeSeeds(sample, seeds, index + 1, port, sha, runs, serve);
}

export async function sessionBefore(input: {
  readonly sha: string;
  readonly seeds: readonly string[];
  readonly port: string;
  readonly runs: string;
  readonly serve: Serve;
}): Promise<void> {
  const dir = worktree(input.sha);
  const sample = path.join(dir, "apps/examples/next-better-supabase");
  try {
    execFileSync("pnpm", ["install", "--frozen-lockfile"], {
      cwd: dir,
      stdio: "inherit",
    });
    execFileSync("pnpm", ["--filter", "permdock", "build"], {
      cwd: dir,
      stdio: "inherit",
    });
    await beforeSeeds(
      sample,
      input.seeds,
      0,
      input.port,
      input.sha,
      input.runs,
      input.serve,
    );
  } finally {
    execFileSync("git", ["worktree", "remove", "--force", dir], {
      cwd: repoRoot,
    });
  }
}

function rememberVariant(name: string, measured: unknown): void {
  const baseline = loadBaseline(baselineFile);
  const checkpoints = isRecord(baseline["checkpoints"])
    ? baseline["checkpoints"]
    : {};
  const after = isRecord(checkpoints["after"]) ? checkpoints["after"] : {};
  const existing = isRecord(after["variants"]) ? after["variants"] : {};
  writeFileSync(
    baselineFile,
    `${JSON.stringify(
      {
        ...baseline,
        checkpoints: {
          ...checkpoints,
          after: { ...after, variants: { ...existing, [name]: measured } },
        },
      },
      null,
      2,
    )}\n`,
  );
  writeReport(baselineFile, reportFile);
}

async function variantAt(
  index: number,
  port: string,
  serve: Serve,
): Promise<void> {
  if (index >= VARIANTS.length) {
    return;
  }
  const name = VARIANTS[index];
  await serve(
    "1000",
    port,
    { MEASURE_WITHOUT: name },
    async (base, databaseUrl) => {
      rememberVariant(name, await measureOff({ base, databaseUrl, runs: 200 }));
    },
  );
  await variantAt(index + 1, port, serve);
}

export async function runVariants(port: string, serve: Serve): Promise<void> {
  await variantAt(0, port, serve);
}
