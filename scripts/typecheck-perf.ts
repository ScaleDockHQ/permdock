import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PERMDOCK = join(ROOT, "packages", "permdock");
const BUDGET = join(ROOT, "scripts", "typecheck-perf.json");
/** Headroom over the recorded count before the gate fails. */
const INSTANTIATION_SLACK = 1.1;
/** CI runners share their cores with the rest of the turbo run, so check time there only reports. */
const ENFORCE_CHECK_TIME = process.env["CI"] === undefined;

const PROJECTS = {
  src: "tsconfig.json",
  tests: "tests/tsconfig.json",
} as const;

type Project = keyof typeof PROJECTS;

interface Budget {
  /** Recorded with `--checkers 1`, the only setting that counts deterministically. */
  readonly instantiations: number;
  /** Wall-clock ceiling in seconds, loose because it depends on the machine. */
  readonly maxCheckSeconds: number;
}

interface Measured {
  readonly instantiations: number;
  readonly checkSeconds: number;
}

function diagnostic(output: string, label: string): number {
  const match = new RegExp(`^${label}:\\s+([\\d.]+)`, "mu").exec(output);
  if (match?.[1] === undefined) {
    throw new Error(`tsc --extendedDiagnostics printed no "${label}" line`);
  }
  return Number(match[1]);
}

function measure(project: Project): Measured {
  const result = spawnSync(
    "pnpm",
    [
      "exec",
      "tsc",
      "--noEmit",
      "--checkers",
      "1",
      "--extendedDiagnostics",
      "-p",
      PROJECTS[project],
    ],
    { cwd: PERMDOCK, encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(
      `tsc failed for ${project}:\n${result.stdout}${result.stderr}`,
    );
  }
  return {
    instantiations: diagnostic(result.stdout, "Instantiations"),
    checkSeconds: diagnostic(result.stdout, "Check time"),
  };
}

function readBudget(): Record<Project, Budget> {
  // SAFETY: the budget file is written by this script in this shape
  return JSON.parse(readFileSync(BUDGET, "utf8")) as Record<Project, Budget>;
}

const write = process.argv.includes("--write");
const budget = readBudget();
const failures: string[] = [];
const next: Record<string, Budget> = {};

for (const project of ["src", "tests"] as const) {
  const measured = measure(project);
  const limit = budget[project];
  next[project] = {
    instantiations: measured.instantiations,
    maxCheckSeconds: limit.maxCheckSeconds,
  };
  process.stdout.write(
    `${project}: ${measured.instantiations} instantiations (recorded ${limit.instantiations}), check ${measured.checkSeconds}s (ceiling ${limit.maxCheckSeconds}s)\n`,
  );
  if (measured.instantiations > limit.instantiations * INSTANTIATION_SLACK) {
    failures.push(
      `${project}: ${measured.instantiations} instantiations is more than ${INSTANTIATION_SLACK}x the recorded ${limit.instantiations}`,
    );
  }
  if (ENFORCE_CHECK_TIME && measured.checkSeconds > limit.maxCheckSeconds) {
    failures.push(
      `${project}: check time ${measured.checkSeconds}s is over the ${limit.maxCheckSeconds}s ceiling`,
    );
  }
}

if (write) {
  writeFileSync(BUDGET, `${JSON.stringify(next, null, 2)}\n`);
  process.stdout.write(`Recorded ${BUDGET}\n`);
} else if (failures.length > 0) {
  process.stderr.write(
    `${failures.join("\n")}\nFind the type that grew, or record the new count on purpose with \`pnpm typecheck:perf --write\`.\n`,
  );
  process.exitCode = 1;
}
