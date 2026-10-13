import { defineCommand } from "citty";

import { type CliContext, type Command, globalArgs } from "./context.ts";
import { COMMAND_DESCRIPTIONS } from "./index.ts";

export function codemod(ctx: CliContext): Command {
  const command = defineCommand({
    meta: {
      name: "codemod",
      description: COMMAND_DESCRIPTIONS.codemod,
    },
    args: {
      ...globalArgs,
      version: {
        type: "positional",
        required: false,
        description: "The release to migrate to (0.5)",
      },
      paths: {
        type: "positional",
        required: false,
        description:
          "Files or directories to rewrite (default: the working directory)",
      },
      "dry-run": {
        type: "boolean",
        description: "Report the renames without writing any file",
      },
    },
    async run({ args: parsed }) {
      // Lazy: oxc-parser and the rename maps load only when this command runs, not for --help.
      const { runCodemod } = await import("../codemod/codemod.ts");
      const [version, ...paths] = parsed._;
      ctx.report(
        runCodemod({
          cwd: ctx.cwd,
          version,
          paths,
          dryRun: parsed["dry-run"] === true,
          json: ctx.json,
        }),
      );
    },
  });
  return command;
}
