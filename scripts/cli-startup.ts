import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(ROOT, "packages", "permdock", "dist", "cli", "bin.js");
const BUDGET = join(ROOT, "scripts", "cli-startup.json");
const RUNS = 9;
/**
 * CI runners share their cores with the rest of the turbo run, so the
 * millisecond ceilings there only report.
 */
const ENFORCE_CEILINGS = process.env["CI"] === undefined;

/**
 * A leaf's `--help` loads that one command module, so each budget catches a
 * heavy import in it.
 */
const COMMANDS = {
  version: ["--version"],
  help: ["--help"],
  "catalog --help": ["catalog", "--help"],
  "doctor --help": ["doctor", "--help"],
  "rls generate --help": ["rls", "generate", "--help"],
  "cloud push --help": ["cloud", "push", "--help"],
} as const;

// SAFETY: COMMANDS is a literal object, so its keys are exactly Command
const NAMES = Object.keys(COMMANDS) as Command[];

type Command = keyof typeof COMMANDS;

interface Budget {
  /** Median wall-clock milliseconds when the budget was recorded. */
  readonly recordedMs: Partial<Record<Command, number>>;
  /**
   * Ceiling in milliseconds per command, loose because it depends on the
   * machine.
   */
  readonly maxMs: Partial<Record<Command, number>>;
  /** `--help` may take at most this multiple of `--version`, plus `helpSlackMs`. */
  readonly maxHelpRatio: number;
  readonly helpSlackMs: number;
}

function once(args: readonly string[]): number {
  const start = performance.now();
  const result = spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  const elapsed = performance.now() - start;
  if (result.status !== 0) {
    throw new Error(
      `permdock ${args.join(" ")} exited ${String(result.status)}:\n${result.stderr}`,
    );
  }
  return elapsed;
}

function median(command: Command): number {
  once(COMMANDS[command]);
  const runs = Array.from({ length: RUNS }, () => once(COMMANDS[command]));
  const sorted = runs.toSorted((a, b) => a - b);
  return Math.round(sorted[Math.floor(sorted.length / 2)] ?? 0);
}

function ms(value: number | undefined): string {
  return value === undefined ? "none" : `${String(value)}ms`;
}

function readBudget(): Budget {
  // SAFETY: the budget file is written by this script in this shape
  return JSON.parse(readFileSync(BUDGET, "utf8")) as Budget;
}

const write = process.argv.includes("--write");
const budget = readBudget();
// SAFETY: one entry per name in NAMES, which covers every Command
const measured = Object.fromEntries(
  NAMES.map((command) => [command, median(command)]),
) as Record<Command, number>;
const failures: string[] = [];

for (const command of NAMES) {
  const label = `permdock ${COMMANDS[command].join(" ")}`;
  const ceiling = budget.maxMs[command];
  process.stdout.write(
    `${label}: ${String(measured[command])}ms median of ${String(RUNS)} (recorded ${ms(budget.recordedMs[command])}, ceiling ${ms(ceiling)})\n`,
  );
  if (ceiling === undefined) {
    failures.push(`${label}: no ceiling in ${BUDGET}`);
  } else if (ENFORCE_CEILINGS && measured[command] > ceiling) {
    failures.push(
      `${label}: ${String(measured[command])}ms is over the ${String(ceiling)}ms ceiling`,
    );
  }
}

const helpLimit = measured.version * budget.maxHelpRatio + budget.helpSlackMs;
if (measured.help > helpLimit) {
  failures.push(
    `--help: ${String(measured.help)}ms is more than ${String(budget.maxHelpRatio)}x --version (${String(measured.version)}ms) plus ${String(budget.helpSlackMs)}ms; the root help must not load the subcommands`,
  );
}

if (write) {
  writeFileSync(
    BUDGET,
    `${JSON.stringify({ ...budget, recordedMs: measured }, null, 2)}\n`,
  );
  process.stdout.write(`Recorded ${BUDGET}\n`);
} else if (failures.length > 0) {
  process.stderr.write(
    `${failures.join("\n")}\nFind the import that grew, or record the new numbers on purpose with \`pnpm cli:startup --write\`.\n`,
  );
  process.exitCode = 1;
}
