import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Times the token hook with the memberships claim on and off at 1, 50, 150 and
 * 500 memberships: `node scripts/hook-bench.ts [--write]`. The seed and the
 * measurements live in `tests/integration/bench/hook-bench.test.ts`; it needs
 * Docker, or `PERMDOCK_POSTGRES_BIN` naming a directory with `initdb` and
 * `pg_ctl`. `--write` records `scripts/hook-bench.json`.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

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
    "bench/hook-bench.test.ts",
  ],
  {
    cwd: ROOT,
    stdio: "inherit",
    env: {
      ...process.env,
      PERMDOCK_HOOK_BENCH: "1",
      ...(process.argv.includes("--write")
        ? { PERMDOCK_HOOK_BENCH_WRITE: "1" }
        : {}),
    },
  },
);
process.exitCode = result.status ?? 1;
