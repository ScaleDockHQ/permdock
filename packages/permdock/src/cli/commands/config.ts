import { defineCommand } from "citty";

import { type CliContext, type Command, globalArgs } from "./context.ts";
import { COMMAND_DESCRIPTIONS } from "./index.ts";

export function config(ctx: CliContext): Command {
  return defineCommand({
    meta: {
      name: "config",
      description: COMMAND_DESCRIPTIONS.config,
    },
    args: {
      ...globalArgs,
      print: {
        type: "boolean",
        description:
          "Print the effective config as JSON: the file, as written, and each default",
      },
      strict: { type: "boolean", description: "Exit 1 on warnings" },
    },
    async run({ args: parsed }) {
      // Lazy: the implementation loads only when this command runs, not for --help.
      const { runConfig } = await import("../config-report.ts");
      ctx.report(
        runConfig({
          cwd: ctx.cwd,
          config: ctx.config,
          file: ctx.configPath,
          warnings: ctx.configWarnings,
          print: parsed.print === true,
          json: ctx.json,
          strict: parsed.strict === true,
        }),
      );
    },
  });
}
