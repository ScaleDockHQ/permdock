import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Records the SQL scale baseline: `node scripts/scale-bench.ts [1k|100k|1M]
 * [--write]`. The seed and the measurements live in
 * `tests/integration/bench/scale-baseline.test.ts`; Docker must be running.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const tier = args.find((arg) => !arg.startsWith("--")) ?? "100k";
if (!["1k", "100k", "1M"].includes(tier)) {
  process.stderr.write(`Unknown tier ${tier}; use 1k, 100k or 1M.\n`);
  process.exit(2);
}

const result = spawnSync(
  "pnpm",
  [
    "--filter",
    "@permdock/integration",
    "exec",
    "vitest",
    "run",
    "--project",
    "rls-bench",
    "bench/scale-baseline.test.ts",
  ],
  {
    cwd: ROOT,
    stdio: "inherit",
    env: {
      ...process.env,
      PERMDOCK_SCALE: "1",
      PERMDOCK_SCALE_TIER: tier,
      ...(args.includes("--write") ? { PERMDOCK_SCALE_WRITE: "1" } : {}),
    },
  },
);
process.exit(result.status ?? 1);
