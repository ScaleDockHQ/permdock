/**
 * Records one checkpoint of a `serve` build.
 *
 * node scripts/measure.ts --checkpoint main node scripts/measure.ts --pr-body
 *
 * With no `--base`, this process starts `serve` itself, once per seed.
 * `--pr-body` prints the pull-request section and starts nothing.
 */
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";

import { measureSeed, waitForHttp } from "./measure-collect.ts";
import { writeReport } from "./measure-pr.ts";
import { loadBaseline } from "./measure-report.ts";

const sampleRoot = path.join(import.meta.dirname, "..");
const repoRoot = path.join(sampleRoot, "../../..");
const baselineFile = path.join(sampleRoot, "perf/baseline.json");
const reportFile = path.join(sampleRoot, "perf/report.md");
const rawDir = path.join(sampleRoot, "perf/raw");

const { values } = parseArgs({
  options: {
    checkpoint: { type: "string" },
    base: { type: "string" },
    seeds: { type: "string", default: "1000,100000" },
    port: { type: "string", default: "3489" },
    runs: { type: "string", default: "5" },
    "pr-body": { type: "boolean", default: false },
    before: { type: "string" },
  },
});

const NAMES = ["main", "native-stack", "interface-kit", "after"] as const;
type CheckpointName = (typeof NAMES)[number];

function isCheckpoint(value: string): value is CheckpointName {
  return NAMES.some((name) => name === value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function commit(): string {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
}

const StackFile = z.object({
  databaseUrl: z.string(),
  port: z.string(),
  statements: z.boolean(),
});

function readStack(file: string): z.infer<typeof StackFile> | null {
  if (!existsSync(file)) {
    return null;
  }
  return StackFile.parse(JSON.parse(readFileSync(file, "utf8")));
}

function stackPath(port: string): string {
  return path.join(os.tmpdir(), `permdock-measure-${port}.json`);
}

function remember(
  checkpoint: CheckpointName,
  seed: string,
  measured: unknown,
): void {
  const baseline = loadBaseline(baselineFile);
  const existing = isRecord(baseline["checkpoints"])
    ? baseline["checkpoints"]
    : {};
  const previous = existing[checkpoint];
  const previousSeeds = isRecord(previous) ? previous["seeds"] : undefined;
  const seedsRecord: Record<string, unknown> = isRecord(previousSeeds)
    ? { ...previousSeeds }
    : {};
  seedsRecord[seed] = measured;
  const notMeasured = new Set<string>();
  if (isRecord(measured) && Array.isArray(measured["notMeasured"])) {
    for (const item of measured["notMeasured"]) {
      notMeasured.add(String(item));
    }
  }
  const checkpoints = {
    ...existing,
    [checkpoint]: {
      commit: commit(),
      node: process.version,
      platform: os.platform(),
      arch: os.arch(),
      measuredAt: new Date().toISOString(),
      seeds: seedsRecord,
      notMeasured: [...notMeasured],
    },
  };
  writeFileSync(
    baselineFile,
    `${JSON.stringify({ ...baseline, checkpoints }, null, 2)}\n`,
  );
  writeReport(baselineFile, reportFile);
}

async function withServe(
  seed: string,
  port: string,
  run: (base: string, databaseUrl: string | null) => Promise<void>,
): Promise<void> {
  const base = `http://127.0.0.1:${port}`;
  const child = spawn("node", ["scripts/serve.ts"], {
    cwd: sampleRoot,
    env: {
      ...process.env,
      MEASURE: "1",
      SEED_QUOTES: seed,
      PORT: port,
      DEMO_LATENCY_MS: "0",
    },
    stdio: "inherit",
  });
  try {
    await waitForHttp(
      `${base}/en`,
      20 * 60 * 1000,
      () => child.exitCode !== null,
    );
    if (child.exitCode !== null) {
      throw new Error("serve exited before the server was ready");
    }
    const ready = readStack(stackPath(port));
    await run(base, ready?.statements === true ? ready.databaseUrl : null);
  } finally {
    child.kill("SIGTERM");
    await new Promise<void>((resolve) => {
      child.once("exit", () => {
        resolve();
      });
    });
  }
}

async function oneSeed(
  checkpoint: CheckpointName,
  seed: string,
  port: string,
): Promise<void> {
  const session = `perf-${checkpoint}-${seed}`;
  const attached = values.base;
  if (attached === undefined) {
    await withServe(seed, port, async (base, databaseUrl) => {
      remember(
        checkpoint,
        seed,
        await measureSeed({
          base,
          seed,
          databaseUrl,
          runs: values.runs,
          session,
          rawDir,
        }),
      );
    });
    return;
  }
  const stack = readStack(stackPath(port));
  remember(
    checkpoint,
    seed,
    await measureSeed({
      base: attached,
      seed,
      databaseUrl: stack?.statements === true ? stack.databaseUrl : null,
      runs: values.runs,
      session,
      rawDir,
    }),
  );
}

async function eachSeed(
  checkpoint: CheckpointName,
  seeds: readonly string[],
  index: number,
  port: string,
): Promise<void> {
  const seed = seeds[index];
  if (seed === undefined) {
    return;
  }
  await oneSeed(checkpoint, seed, port);
  await eachSeed(checkpoint, seeds, index + 1, port);
}

async function main(): Promise<void> {
  if (values["pr-body"]) {
    process.stdout.write(writeReport(baselineFile, reportFile));
    return;
  }
  if (values.before !== undefined) {
    throw new Error(
      "--before runs at the final checkpoint, from a worktree of the tooling commit. Record --checkpoint main first.",
    );
  }
  const checkpoint = values.checkpoint ?? "";
  if (!isCheckpoint(checkpoint)) {
    throw new Error(
      "Pass --checkpoint main|native-stack|interface-kit|after, or --pr-body",
    );
  }
  const seeds = values.seeds
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  await eachSeed(checkpoint, seeds, 0, values.port);
  process.stdout.write(`${baselineFile}\n`);
}

await main();
