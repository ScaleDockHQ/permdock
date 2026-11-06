import type { FlagValues } from "../core/command.ts";
import type { Leaf } from "../core/command.ts";
import type { CliContext } from "../core/context.ts";
import type { CommandResult } from "../core/result.ts";

import { parseLeaf } from "../core/args.ts";
import { defineLeaf } from "../core/command.ts";
import {
  checkFlag,
  dbUrl,
  dbUrlFlags,
  fileOut,
  given,
  policyFlag,
} from "../core/flags.ts";

const powersyncGenerateFlags = {
  out: {
    type: "string",
    description: "The Sync Streams file (default sync-config.yaml)",
    valueHint: "file",
  },
  ...checkFlag,
  ...policyFlag,
} as const;

export function powersyncGenerateFromFlags(
  ctx: CliContext,
  argv: readonly string[],
): Promise<CommandResult> {
  const parsed = parseLeaf("powersync generate", argv, powersyncGenerateFlags);
  // SAFETY: parseLeaf widens the flag object to Flags; the values are this command's.
  return executePowersyncGenerate(
    ctx,
    parsed.flags as FlagValues<typeof powersyncGenerateFlags>,
  );
}

async function executePowersyncGenerate(
  ctx: CliContext,
  flags: FlagValues<typeof powersyncGenerateFlags>,
): Promise<CommandResult> {
  const out = fileOut("powersync", flags.out);
  const from = given(flags.policy);
  // Lazy: the implementation loads only when this command runs, not for --help.
  const { runPowerSync } = await import("../powersync/powersync.ts");
  return runPowerSync({
    cwd: ctx.cwd,
    config: ctx.config,
    rest: ["generate"],
    check: flags.check,
    ...(out === undefined ? {} : { out }),
    ...(from === undefined ? {} : { from }),
  });
}

export const verify: Leaf = defineLeaf({
  flags: {
    out: {
      type: "string",
      description: "The Sync Streams file to verify (default sync-config.yaml)",
      valueHint: "file",
    },
    ...dbUrlFlags,
    fixtures: {
      type: "string",
      description: "Fixtures file (default rls.fixtures.json)",
      valueHint: "file",
    },
    ...policyFlag,
  },
  async run(ctx, { flags }) {
    const out = fileOut("powersync", flags.out);
    const db = await dbUrl(ctx, flags, { required: true });
    const fixtures = given(flags.fixtures);
    const from = given(flags.policy);
    // Lazy: the implementation loads only when this command runs, not for --help.
    const { runPowerSync } = await import("../powersync/powersync.ts");
    return runPowerSync({
      cwd: ctx.cwd,
      config: ctx.config,
      rest: ["verify"],
      check: false,
      ...(out === undefined ? {} : { out }),
      ...(db === undefined ? {} : { db }),
      ...(fixtures === undefined ? {} : { fixtures }),
      ...(from === undefined ? {} : { from }),
    });
  },
});
