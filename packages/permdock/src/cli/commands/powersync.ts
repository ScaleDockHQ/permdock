import { defineCommand } from "citty";

import {
  type CliContext,
  type Command,
  globalArgs,
  stringArg,
} from "./context.ts";
import { COMMAND_DESCRIPTIONS } from "./index.ts";

export function powersync(ctx: CliContext): Command {
  const command = defineCommand({
    meta: {
      name: "powersync",
      description: COMMAND_DESCRIPTIONS.powersync,
    },
    args: {
      ...globalArgs,
      verb: {
        type: "positional",
        required: false,
        description: "generate or verify",
      },
      out: {
        type: "string",
        description: "The Sync Streams file (default sync-config.yaml)",
        valueHint: "file",
      },
      check: {
        type: "boolean",
        description:
          "generate: exit 1 when the file on disk is stale; write nothing",
      },
      db: {
        type: "string",
        description:
          "verify: Postgres connection string to run the fixtures against",
        valueHint: "url",
      },
      fixtures: {
        type: "string",
        description: "verify: fixtures file (default rls.fixtures.json)",
        valueHint: "file",
      },
      from: {
        type: "string",
        description: "Module exporting policy (default: policy in the config)",
        valueHint: "file",
      },
    },
    async run({ args: parsed }) {
      const out = stringArg(parsed.out);
      const db = stringArg(parsed.db);
      const fixtures = stringArg(parsed.fixtures);
      const from = stringArg(parsed.from);
      // Lazy: the implementation loads only when this command runs, not for --help.
      const { runPowerSync } = await import("../powersync.ts");
      ctx.report(
        await runPowerSync({
          cwd: ctx.cwd,
          config: ctx.config,
          rest: parsed._,
          check: parsed.check === true,
          ...(out === undefined ? {} : { out }),
          ...(db === undefined ? {} : { db }),
          ...(fixtures === undefined ? {} : { fixtures }),
          ...(from === undefined ? {} : { from }),
        }),
      );
    },
  });
  return command;
}
