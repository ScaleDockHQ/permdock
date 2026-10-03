import { defineCommand } from "citty";

import {
  type CliContext,
  type Command,
  globalArgs,
  stringArg,
} from "./context.ts";
import { COMMAND_DESCRIPTIONS } from "./index.ts";

export function supabase(ctx: CliContext): Command {
  const command = defineCommand({
    meta: {
      name: "supabase",
      description: COMMAND_DESCRIPTIONS.supabase,
    },
    args: {
      ...globalArgs,
      area: {
        type: "positional",
        required: false,
        description: "hook or inspect",
      },
      verb: {
        type: "positional",
        required: false,
        description: "hook: generate",
      },
      out: {
        type: "string",
        description:
          "File to write; a bare --out on inspect writes permdock.manifest.json",
        valueHint: "file",
      },
      check: {
        type: "boolean",
        description: "Exit 1 when the file on disk is stale; write nothing",
      },
      db: {
        type: "string",
        description: "Postgres connection string",
        valueHint: "url",
      },
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
      "grants-out": {
        type: "string",
        description: "File for the supabase_auth_admin grants",
        valueHint: "file",
      },
    },
    async run({ args: parsed }) {
      const out = parsed.out === "" ? true : stringArg(parsed.out);
      const db = stringArg(parsed.db);
      const activeFrom = stringArg(parsed["active-from"]);
      const budget = stringArg(parsed.budget);
      const schema = stringArg(parsed.schema);
      const grantsOut = stringArg(parsed["grants-out"]);
      // Lazy: the implementation loads only when this command runs, not for --help.
      const { runSupabase } = await import("../supabase-hook.ts");
      ctx.report(
        await runSupabase({
          cwd: ctx.cwd,
          config: ctx.config,
          rest: parsed._,
          check: parsed.check === true,
          json: ctx.json,
          io: ctx.io,
          ...(out === undefined ? {} : { out }),
          ...(db === undefined ? {} : { db }),
          ...(activeFrom === undefined ? {} : { activeFrom }),
          ...(budget === undefined ? {} : { budget }),
          ...(schema === undefined ? {} : { schema }),
          ...(grantsOut === undefined ? {} : { grantsOut }),
        }),
      );
    },
  });
  return command;
}
