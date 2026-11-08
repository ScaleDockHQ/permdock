import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Records the runtime and token matrix: `node scripts/runtime-perf.ts [--quick]
 * [--write]` runs `packages/permdock/tests/bench/scale-runner.ts` and writes
 * `scripts/runtime-perf.json` with `--write`.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const result = spawnSync(
  process.execPath,
  [
    join(ROOT, "packages/permdock/tests/bench/scale-runner.ts"),
    ...process.argv.slice(2),
  ],
  { stdio: "inherit" },
);
process.exitCode = result.status ?? 1;
