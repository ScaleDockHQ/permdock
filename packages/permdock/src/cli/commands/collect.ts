import { defineCommand } from "citty";

import {
  type CliContext,
  type Command,
  globalArgs,
  listArg,
  stringArg,
} from "./context.ts";
import { COMMAND_DESCRIPTIONS } from "./index.ts";

export function collect(ctx: CliContext): Command {
  const command = defineCommand({
    meta: {
      name: "collect",
      description: COMMAND_DESCRIPTIONS.collect,
    },
    args: {
      ...globalArgs,
      check: {
        type: "boolean",
        description: "Exit 1 when the catalog on disk is stale; write nothing",
      },
      src: {
        type: "string",
        description: "Source roots or globs, repeatable or comma-separated",
        valueHint: "path",
      },
      out: {
        type: "string",
        description: "Catalog file to write",
        valueHint: "file",
      },
    },
    async run({ args: parsed, rawArgs }) {
      const src = listArg(rawArgs, "src");
      const out = stringArg(parsed.out);
      // Lazy: the implementation loads only when this command runs, not for --help.
      const result = await (
        await import("../collect.ts")
      ).runCollect({
        cwd: ctx.cwd,
        config: ctx.config,
        collect: {
          ...(src.length > 0 ? { srcPath: src } : {}),
          ...(out === undefined ? {} : { out }),
        },
        check: parsed.check === true,
        now: ctx.now,
        io: ctx.io,
      });
      ctx.report({ code: result.code, output: result.message });
    },
  });
  return command;
}
