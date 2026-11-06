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
const FIXTURES = join(ROOT, "tests", "integration", "fixtures");
/**
 * Headroom over the recorded peak RSS before the gate fails. Wall time is
 * printed against the idle recording and not enforced: a `pnpm verify` run
 * shares the machine with the rest of turbo, so the clock is not the cost.
 */
const SLACK = 1.1;

/**
 * Both fixtures: the small one runs the rls plugin only, the large one every
 * plugin.
 */
const FIXTURE_RUNS = [
  { name: "small", dir: "generate-perf", only: ["--only", "rls"] },
  { name: "large", dir: "generate-perf-large", only: [] },
] as const;

interface Sample {
  /** Wall-clock milliseconds. */
  readonly ms: number;
  /** Peak resident set, kilobytes, from `/usr/bin/time`. */
  readonly rssKb: number;
}

interface FixtureBudget {
  /** `--no-cache`: every plugin emits. */
  readonly cold: Sample;
  /** A second run over an unchanged policy: the cache answers. */
  readonly warm: Sample;
  /** A one-line edit of `policy.ts`, then a full generate. */
  readonly oneFile: Sample;
}

interface Budget {
  readonly small: FixtureBudget;
  readonly large: FixtureBudget;
  /**
   * Reference only, never gated: `permdock rls generate` cold on origin/main
   * (d29d6d62b) over the large fixture, and `generate --only rls --no-cache` on
   * this branch over the same fixture, median of six idle runs.
   */
  readonly main: {
    readonly rlsGenerateCold: Sample;
    readonly branchRlsOnlyCold: Sample;
  };
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

function measure(cwd: string, args: readonly string[]): Sample {
  const time = timeCommand();
  const start = performance.now();
  const result = spawnSync(
    time.bin,
    [...time.prefix, process.execPath, BIN, ...args],
    { cwd, encoding: "utf8", env: { ...process.env, PERMDOCK_AGENT: "no" } },
  );
  const ms = Math.round(performance.now() - start);
  const code = result.status ?? 1;
  if (code !== 0) {
    throw new Error(
      `permdock ${args.join(" ")} exited ${code}\n${result.stderr}`,
    );
  }
  return { ms, rssKb: peakRssKb(result.stderr) };
}

function prepare(dir: string): string {
  // Under the integration workspace so `permdock` resolves from its node_modules.
  const root = join(ROOT, "tests", "integration", "tmp");
  mkdirSync(root, { recursive: true });
  const cwd = mkdtempSync(join(root, "generate-perf-"));
  cpSync(join(FIXTURES, dir), cwd, { recursive: true });
  return cwd;
}

function measureFixture(run: (typeof FIXTURE_RUNS)[number]): FixtureBudget {
  const cwd = prepare(run.dir);
  try {
    const base = ["generate", ...run.only] as const;
    const cold = measure(cwd, [...base, "--no-cache"]);
    // The first cached run writes the cache entry; the second reads it.
    measure(cwd, base);
    const warm = measure(cwd, base);
    const policyPath = join(cwd, "policy.ts");
    writeFileSync(
      policyPath,
      `${readFileSync(policyPath, "utf8")}\n// one-file change\n`,
    );
    const oneFile = measure(cwd, base);
    return { cold, warm, oneFile };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

function main(): void {
  const write = process.argv.includes("--write");
  const recorded = readBudget();
  const measured: Budget = {
    small: measureFixture(FIXTURE_RUNS[0]),
    large: measureFixture(FIXTURE_RUNS[1]),
    main: recorded.main,
  };
  const budget = write ? measured : recorded;
  const failures: string[] = [];
  for (const run of FIXTURE_RUNS) {
    for (const key of ["cold", "warm", "oneFile"] as const) {
      const got = measured[run.name][key];
      const limit = budget[run.name][key];
      process.stdout.write(
        `${run.name} ${key}: ${got.ms} ms (recorded ${limit.ms}), peak RSS ${got.rssKb} KB (recorded ${limit.rssKb})\n`,
      );
      if (got.rssKb > limit.rssKb * SLACK) {
        failures.push(
          `${run.name} ${key}: peak RSS ${got.rssKb} KB is more than ${SLACK}x the recorded ${limit.rssKb} KB`,
        );
      }
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
}

main();
