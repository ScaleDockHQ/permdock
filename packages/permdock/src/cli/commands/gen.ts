import type { FlagValues } from "../core/command.ts";
import type { CliContext } from "../core/context.ts";
import type { CommandResult } from "../core/result.ts";

import { parseLeaf } from "../core/args.ts";
import { checkFlag, dryRunFlag, given, policyFlag } from "../core/flags.ts";

const genFlags = {
  kind: {
    type: "enum",
    options: [
      "constants",
      "zod",
      "valibot",
      "arktype",
      "json-schema",
      "standard-schema",
      "factories",
      "react",
      "vue",
      "svelte",
      "solid",
      "messages",
      "bundle",
    ],
    repeatable: true,
    description: "What to write (default gen.kinds, else constants)",
    valueHint: "kind",
  },
  out: {
    type: "string",
    description: "File for a single kind (- for stdout), without its siblings",
    valueHint: "file",
  },
  "out-dir": {
    type: "string",
    description: "Directory for the files (default gen.out, else src/permdock)",
    valueHint: "dir",
  },
  ...checkFlag,
  ...dryRunFlag,
  ...policyFlag,
} as const;

export function genFromFlags(
  ctx: CliContext,
  argv: readonly string[],
): Promise<CommandResult> {
  const parsed = parseLeaf("gen", argv, genFlags);
  // SAFETY: parseLeaf widens the flag object to Flags; the values are this command's.
  return executeGen(ctx, parsed.flags as FlagValues<typeof genFlags>);
}

async function executeGen(
  ctx: CliContext,
  flags: FlagValues<typeof genFlags>,
): Promise<CommandResult> {
  const out = given(flags.out);
  const outDir = given(flags["out-dir"]);
  const from = given(flags.policy);
  // Lazy: the implementation loads only when this command runs, not for --help.
  const { runGen } = await import("../gen/gen.ts");
  return runGen({
    cwd: ctx.cwd,
    config: ctx.config,
    kinds: flags.kind,
    check: flags.check,
    dryRun: flags["dry-run"],
    ...(out === undefined ? {} : { out }),
    ...(outDir === undefined ? {} : { outDir }),
    ...(from === undefined ? {} : { from }),
  });
}
