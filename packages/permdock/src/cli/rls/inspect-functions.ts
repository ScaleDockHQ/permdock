import type { CommandResult } from "../core/result.ts";
import type { PermDockConfig } from "../types.ts";

import { functionShares } from "./shared-functions.ts";
import { configuredTableReads } from "./table-reads.ts";

/**
 * `permdock supabase inspect --functions <pattern>`: for each function the
 * schema files define that matches the pattern, `pass` when
 * `rls.sharedFunctions` lists it, else every reason it is not shared.
 */
export async function inspectFunctions(input: {
  readonly cwd: string;
  readonly config: PermDockConfig;
  readonly pattern: string;
  readonly json: boolean;
}): Promise<CommandResult> {
  const tableReads = await configuredTableReads(input.cwd, input.config);
  const found = await functionShares(
    {
      cwd: input.cwd,
      config: input.config,
      schema: input.config.rls?.schema ?? "permdock",
      tableReads,
    },
    input.pattern,
  );
  const passed = found.filter((entry) => entry.shared).length;
  if (input.json) {
    const data = { pattern: input.pattern, passed, functions: found };
    return { code: 0, output: JSON.stringify(data, null, 2), data };
  }
  return {
    code: 0,
    output: [
      `permdock supabase inspect: ${String(passed)} of ${String(found.length)} functions matching ${input.pattern} are shared`,
      ...found.flatMap((entry) =>
        entry.shared
          ? [`  pass ${entry.function}`]
          : [
              `  ${entry.function}`,
              ...entry.reasons.map((reason) => `    ${reason}`),
            ],
      ),
    ].join("\n"),
  };
}
