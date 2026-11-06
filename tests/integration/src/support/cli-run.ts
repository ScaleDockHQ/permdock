import type { RunResult } from "permdock/cli";

import { run as runCli } from "permdock/cli";

import { hookGenerate, rlsGenerate } from "./rls.ts";

type RunOptions = NonNullable<Parameters<typeof runCli>[1]>;

/**
 * `permdock/cli` `run`, with the removed `rls generate` and `supabase hook
 * generate` argv translated to `generate --only`.
 */
export function run(
  argv: readonly string[],
  options?: RunOptions,
): Promise<RunResult> {
  const cwd = options?.cwd;
  const located = cwd === undefined ? {} : { cwd };
  if (argv[0] === "rls" && argv[1] === "generate") {
    return rlsGenerate(argv.slice(2), located);
  }
  if (argv[0] === "supabase" && argv[1] === "hook" && argv[2] === "generate") {
    return hookGenerate(argv.slice(3), located);
  }
  return runCli(argv, options);
}
