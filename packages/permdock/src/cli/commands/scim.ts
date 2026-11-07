import type { FlagValues } from "../core/command.ts";
import type { CliContext } from "../core/context.ts";
import type { CommandResult } from "../core/result.ts";

import { parseLeaf } from "../core/args.ts";
import { checkFlag, dryRunFlag, given } from "../core/flags.ts";

const scimGenerateFlags = {
  out: {
    type: "string",
    description:
      "File to write, - for stdout (default supabase/schemas/<schema>/scim.sql, else permdock_scim.sql)",
    valueHint: "file",
  },
  dialect: {
    type: "enum",
    options: ["supabase", "neon", "guc"],
    description:
      "Which client roles lose access to the tables (default rls.dialect, else supabase)",
  },
  schema: {
    type: "string",
    description:
      "Schema for the directory tables (default rls.schema, else permdock)",
    valueHint: "name",
  },
  ...checkFlag,
  ...dryRunFlag,
} as const;

export function scimGenerateFromFlags(
  ctx: CliContext,
  argv: readonly string[],
): Promise<CommandResult> {
  const parsed = parseLeaf("scim generate", argv, scimGenerateFlags);
  // SAFETY: parseLeaf widens the flag object to Flags; the values are this command's.
  return executeScimGenerate(
    ctx,
    parsed.flags as FlagValues<typeof scimGenerateFlags>,
  );
}

async function executeScimGenerate(
  ctx: CliContext,
  flags: FlagValues<typeof scimGenerateFlags>,
): Promise<CommandResult> {
  const out = given(flags.out);
  const schema = given(flags.schema);
  // Lazy: the implementation loads only when this command runs, not for --help.
  const { runScimGenerate } = await import("../scim/generate.ts");
  return runScimGenerate({
    cwd: ctx.cwd,
    config: ctx.config,
    check: flags.check,
    dryRun: flags["dry-run"],
    ...(out === undefined ? {} : { out }),
    ...(schema === undefined ? {} : { schema }),
    ...(flags.dialect === undefined ? {} : { dialect: flags.dialect }),
  });
}
