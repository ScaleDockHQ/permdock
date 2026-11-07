import type { FlagValues } from "../core/command.ts";
import type { Leaf } from "../core/command.ts";
import type { CliContext } from "../core/context.ts";
import type { CommandResult } from "../core/result.ts";

import { parseLeaf } from "../core/args.ts";
import { defineLeaf } from "../core/command.ts";
import { checkFlag, dbUrl, dbUrlFlags, fileOut, given } from "../core/flags.ts";

const hookGenerateFlags = {
  out: { type: "string", description: "File to write", valueHint: "file" },
  ...checkFlag,
  ...dbUrlFlags,
  "active-from": {
    type: "string",
    description: "Where the hook reads the active tenant",
    valueHint: "source",
  },
  budget: {
    type: "string",
    description: "Byte budget for the memberships claim",
    valueHint: "bytes",
  },
  schema: {
    type: "string",
    description: "Schema for the hook function",
    valueHint: "name",
  },
  schemas: {
    type: "enum",
    options: ["pg-delta", "migra", "migrations"],
    description: "Schema workflow (default supabase.schemas, else pg-delta)",
  },
  "grants-out": {
    type: "string",
    description: "migra: file for the privileges supabase db diff drops",
    valueHint: "file",
  },
} as const;

export function hookGenerateFromFlags(
  ctx: CliContext,
  argv: readonly string[],
): Promise<CommandResult> {
  const parsed = parseLeaf("supabase hook generate", argv, hookGenerateFlags);
  // SAFETY: parseLeaf widens the flag object to Flags; the values are this command's.
  return executeHookGenerate(
    ctx,
    parsed.flags as FlagValues<typeof hookGenerateFlags>,
  );
}

async function executeHookGenerate(
  ctx: CliContext,
  flags: FlagValues<typeof hookGenerateFlags>,
): Promise<CommandResult> {
  const out = fileOut("supabase hook generate", flags.out);
  const db = await dbUrl(ctx, flags);
  const activeFrom = given(flags["active-from"]);
  const budget = given(flags.budget);
  const schema = given(flags.schema);
  const grantsOut = given(flags["grants-out"]);
  // Lazy: the implementation loads only when this command runs, not for --help.
  const { runSupabase } = await import("../supabase-hook/supabase-hook.ts");
  return runSupabase({
    cwd: ctx.cwd,
    config: ctx.config,
    rest: ["hook", "generate"],
    check: flags.check,
    json: ctx.json,
    io: ctx.io,
    ...(out === undefined ? {} : { out }),
    ...(db === undefined ? {} : { db }),
    ...(activeFrom === undefined ? {} : { activeFrom }),
    ...(budget === undefined ? {} : { budget }),
    ...(schema === undefined ? {} : { schema }),
    ...(grantsOut === undefined ? {} : { grantsOut }),
    ...(flags.schemas === undefined ? {} : { schemas: flags.schemas }),
  });
}

export const inspect: Leaf = defineLeaf({
  flags: {
    out: {
      type: "string",
      description: "File to write; a bare --out writes permdock.manifest.json",
      valueHint: "file",
    },
    ...checkFlag,
  },
  async run(ctx, { flags }) {
    const out =
      flags.out === "" ? true : flags.out === "-" ? undefined : flags.out;
    // Lazy: the implementation loads only when this command runs, not for --help.
    const { runSupabase } = await import("../supabase-hook/supabase-hook.ts");
    return runSupabase({
      cwd: ctx.cwd,
      config: ctx.config,
      rest: ["inspect"],
      check: flags.check,
      json: ctx.json,
      io: ctx.io,
      ...(out === undefined ? {} : { out }),
    });
  },
});
