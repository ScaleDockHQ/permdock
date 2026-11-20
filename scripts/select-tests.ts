/* oxlint-disable turbo/no-undeclared-env-vars -- a CLI, not a Turbo task: SELECT_BASE is not a cache input */
// Runs the test files a diff can reach. Usage: node scripts/select-tests.ts <unit|integration> [--list]
// `unit` is packages/permdock, `integration` is tests/integration. A diff that touches an input the
// module graph cannot see (lockfile, config, workflows, fixtures) runs the whole suite.
import { execFileSync, spawnSync } from "node:child_process";
import { globSync } from "node:fs";
import path from "node:path";

type Suite = "unit" | "integration";

interface SuiteConfig {
  readonly cwd: string;
  readonly project: string | null;
  readonly always: readonly string[];
}

const root = path.resolve(import.meta.dirname, "..");

const SUITES: Readonly<Record<Suite, SuiteConfig>> = {
  unit: {
    cwd: "packages/permdock",
    project: null,
    always: [
      "tests/invariants/**/*.test.ts",
      "tests/package/**/*.test.ts",
      "tests/standards/**/*.test.ts",
    ],
  },
  integration: { cwd: "tests/integration", project: "integration", always: [] },
};

// A change here can break a test without appearing in any test's import graph.
const WIDEN: readonly RegExp[] = [
  /^pnpm-lock\.yaml$/u,
  /^pnpm-workspace\.yaml$/u,
  /(^|\/)package\.json$/u,
  /^turbo\.json$/u,
  /(^|\/)tsconfig[^/]*\.json$/u,
  /(^|\/)vitest[^/]*\.config\.[cm]?[jt]s$/u,
  /^\.github\//u,
  /^scripts\/select-tests\.ts$/u,
  /^(packages\/permdock\/tests|tests\/[^/]+)\/(?!.*\.tsx?$).+/u,
  /^packages\/permdock\/(schemas|rulesets|skills)\//u,
];

function git(...args: readonly string[]): string {
  return execFileSync("git", [...args], { cwd: root, encoding: "utf8" }).trim();
}

function parseSuite(value: string | undefined): Suite {
  if (value === "unit" || value === "integration") {
    return value;
  }
  throw new Error("usage: select-tests.ts <unit|integration> [--list]");
}

function say(line: string): void {
  process.stdout.write(`${line}\n`);
}

function run(config: SuiteConfig, files: readonly string[]): number {
  const args = ["exec", "vitest", "run", "--coverage.enabled=false"];
  if (config.project !== null) {
    args.push("--project", config.project);
  }
  args.push(...files);
  const result = spawnSync("pnpm", args, {
    cwd: path.join(root, config.cwd),
    stdio: "inherit",
  });
  return result.status ?? 1;
}

// `permdock` resolves to src/ for the list step so the graph reaches the library.
function listChanged(config: SuiteConfig, mergeBase: string): Set<string> {
  const listed = execFileSync(
    "pnpm",
    [
      "exec",
      "vitest",
      "list",
      "--changed",
      mergeBase,
      "--filesOnly",
      ...(config.project === null ? [] : ["--project", config.project]),
    ],
    {
      cwd: path.join(root, config.cwd),
      encoding: "utf8",
      env: { ...process.env, PERMDOCK_SELECT_SRC: "1" },
    },
  );
  const selected = new Set<string>();
  for (const line of listed.split("\n")) {
    const match = /^(?:\[[^\]]+\]\s+)?(\S+\.test\.tsx?)$/u.exec(line.trim());
    if (match?.[1] !== undefined) {
      selected.add(match[1]);
    }
  }
  return selected;
}

function widensSuite(file: string): boolean {
  for (const rx of WIDEN) {
    if (rx.test(file)) {
      return true;
    }
  }
  return false;
}

function main(): number {
  const suite = parseSuite(process.argv[2]);
  const listOnly = process.argv.includes("--list");
  const config = SUITES[suite];
  const mergeBase = git(
    "merge-base",
    process.env["SELECT_BASE"] ?? "origin/main",
    "HEAD",
  );
  const changed = git("diff", "--name-only", mergeBase)
    .split("\n")
    .filter((line) => line !== "");

  const widened = changed.find((file) => widensSuite(file));
  if (widened !== undefined) {
    say(`full ${suite} suite: ${widened} is outside the module graph`);
    return listOnly ? 0 : run(config, []);
  }

  const selected = listChanged(config, mergeBase);
  if (changed.length > 0) {
    for (const pattern of config.always) {
      for (const file of globSync(pattern, {
        cwd: path.join(root, config.cwd),
      })) {
        selected.add(file);
      }
    }
  }

  say(`${suite}: ${selected.size} test files selected`);
  if (listOnly) {
    for (const file of [...selected].toSorted()) {
      say(file);
    }
    return 0;
  }
  return selected.size === 0 ? 0 : run(config, [...selected]);
}

process.exitCode = main();
