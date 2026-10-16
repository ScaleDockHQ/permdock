import { defineCommand } from "citty";

import {
  type CliContext,
  type Command,
  globalArgs,
  listArg,
} from "./context.ts";
import { COMMAND_DESCRIPTIONS } from "./index.ts";

export function scan(ctx: CliContext): Command {
  return defineCommand({
    meta: { name: "scan", description: COMMAND_DESCRIPTIONS.scan },
    args: {
      ...globalArgs,
      legacy: {
        type: "boolean",
        description: "List authorization checks written without PermDock",
      },
      pattern: {
        type: "string",
        description: "An extra regular expression to report, repeatable",
        valueHint: "regex",
      },
      src: {
        type: "string",
        description:
          "Directories to scan, comma-separated (default collect.srcPath or src)",
        valueHint: "dirs",
      },
    },
    async run({ args: parsed, rawArgs }) {
      if (parsed.legacy !== true) {
        ctx.report({
          code: 2,
          output: "permdock scan: pass --legacy (the only scan so far)\n",
        });
        return;
      }
      // Lazy: the implementation loads only when this command runs, not for --help.
      const { runLegacyScan } = await import("../legacy-scan.ts");
      const src = listArg(rawArgs, "src");
      ctx.report(
        runLegacyScan({
          cwd: ctx.cwd,
          srcPath:
            src.length > 0 ? src : (ctx.config.collect?.srcPath ?? ["src"]),
          patterns: listArg(rawArgs, "pattern"),
          json: ctx.json,
        }),
      );
    },
  });
}
