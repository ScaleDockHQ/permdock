import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(ROOT, "packages", "permdock", "dist", "cli", "bin.js");
const BUDGET = join(ROOT, "scripts", "generate-perf.json");
const FIXTURE = join(ROOT, "tests", "integration", "fixtures", "generate-perf");
/**
 * Headroom over the recorded peak RSS before the gate fails. Wall time is
 * printed against the idle recording and not enforced: a `pnpm verify` run
 * shares the machine with the rest of turbo, so the clock is not the cost.
 */
const SLACK = 1.1;

/** `generate --only rls`, with the cache off so the run still emits. */
const ARGS = ["generate", "--only", "rls", "--no-cache"] as const;

interface Sample {
  /** Wall-clock milliseconds. */
  readonly ms: number;
  /** Peak resident set, kilobytes, from `/usr/bin/time`. */
  readonly rssKb: number;
}

interface Budget {
  readonly cold: Sample;
  readonly warm: Sample;
  /**
   * A one-line edit of `policy.ts`, then a full generate. Watch does not exist
   * yet.
   */
  readonly oneFile: Sample;
}

function readBudget(): Budget {
  // SAFETY: this script writes the file in this shape.
  return JSON.parse(readFileSync(BUDGET, "utf8")) as Budget;
}

/** macOS `time -l` reports bytes; GNU `time -v` reports kilobytes. */
function peakRssKb(report: string): number {
  const darwin = /^\s*(\d+)\s+maximum resident set size/mu.exec(report);
  if (darwin?.[1] !== undefined) {
    return Math.round(Number(darwin[1]) / 1024);
  }
  const gnu = /Maximum resident set size \(kbytes\):\s*(\d+)/u.exec(report);
  if (gnu?.[1] !== undefined) {
    return Number(gnu[1]);
  }
  throw new Error("time printed no peak resident set size");
}

function timeCommand(): {
  readonly bin: string;
  readonly prefix: readonly string[];
} {
  if (process.platform === "darwin") {
    return { bin: "/usr/bin/time", prefix: ["-l"] };
  }
  if (process.platform === "linux") {
    return { bin: "/usr/bin/time", prefix: ["-v"] };
  }
  throw new Error(
    `generate:perf has no peak-RSS probe for ${process.platform}`,
  );
}

function run(
  cwd: string,
): Sample & { readonly code: number; readonly stderr: string } {
  const time = timeCommand();
  const start = performance.now();
  const result = spawnSync(
    time.bin,
    [...time.prefix, process.execPath, BIN, ...ARGS],
    { cwd, encoding: "utf8", env: { ...process.env, PERMDOCK_AGENT: "no" } },
  );
  const stderr = result.stderr;
  const code = result.status ?? 1;
  return {
    ms: Math.round(performance.now() - start),
    rssKb: code === 0 ? peakRssKb(stderr) : 0,
    code,
    stderr,
  };
}

function measure(cwd: string): Sample {
  const sample = run(cwd);
  if (sample.code !== 0) {
    throw new Error(
      `permdock ${ARGS.join(" ")} exited ${sample.code}\n${sample.stderr}`,
    );
  }
  return { ms: sample.ms, rssKb: sample.rssKb };
}

function prepare(): string {
  // Under the integration workspace so `permdock` resolves from its node_modules.
  const root = join(ROOT, "tests", "integration", "tmp");
  mkdirSync(root, { recursive: true });
  const cwd = mkdtempSync(join(root, "generate-perf-"));
  cpSync(FIXTURE, cwd, { recursive: true });
  return cwd;
}

function main(): void {
  const write = process.argv.includes("--write");
  const cwd = prepare();
  try {
    const cold = measure(cwd);
    const warm = measure(cwd);
    const policyPath = join(cwd, "policy.ts");
    writeFileSync(
      policyPath,
      `${readFileSync(policyPath, "utf8")}\n// one-file change\n`,
    );
    const oneFile = measure(cwd);
    const measured: Budget = { cold, warm, oneFile };
    const budget = write ? measured : readBudget();
    const failures: string[] = [];
    for (const key of ["cold", "warm", "oneFile"] as const) {
      const got = measured[key];
      const limit = budget[key];
      process.stdout.write(
        `${key}: ${got.ms} ms (recorded ${limit.ms}), peak RSS ${got.rssKb} KB (recorded ${limit.rssKb})\n`,
      );
      if (got.rssKb > limit.rssKb * SLACK) {
        failures.push(
          `${key}: peak RSS ${got.rssKb} KB is more than ${SLACK}x the recorded ${limit.rssKb} KB`,
        );
      }
    }
    if (write) {
      writeFileSync(BUDGET, `${JSON.stringify(measured, null, 2)}\n`);
      process.stdout.write(`Recorded ${BUDGET}\n`);
    } else if (failures.length > 0) {
      process.stderr.write(
        `${failures.join("\n")}\nFind what grew, or record the new numbers on purpose with \`pnpm generate:perf --write\`.\n`,
      );
      process.exitCode = 1;
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

main();
