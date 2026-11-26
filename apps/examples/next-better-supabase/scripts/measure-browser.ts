import { execFileSync } from "node:child_process";
import path from "node:path";

const repoRoot = path.join(import.meta.dirname, "../../../..");

/**
 * One agent-browser pass. `only` limits the routes when a checkpoint already
 * has the rest.
 */
export function runBrowser(input: {
  readonly base: string;
  readonly seed: string;
  readonly out: string;
  readonly runs: string;
  readonly session: string;
  readonly includeNew: boolean;
  readonly only: string | undefined;
}): void {
  execFileSync(
    "node",
    [
      path.join(repoRoot, "scripts/next-baseline.ts"),
      "--sample",
      "supabase",
      "--base",
      input.base,
      "--seed",
      input.seed,
      "--runs",
      input.runs,
      "--session",
      input.session,
      "--out",
      input.out,
    ],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        ...(input.includeNew ? { MEASURE_NEW: "1" } : {}),
        ...(input.only === undefined ? {} : { MEASURE_ONLY: input.only }),
      },
      stdio: "inherit",
      timeout: 45 * 60 * 1000,
    },
  );
}
