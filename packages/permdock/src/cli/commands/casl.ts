import { defineCommand } from "citty";

import {
  type CliContext,
  type Command,
  globalArgs,
  stringArg,
} from "./context.ts";
import { COMMAND_DESCRIPTIONS } from "./index.ts";

export function casl(ctx: CliContext): Command {
  return defineCommand({
    meta: { name: "casl", description: COMMAND_DESCRIPTIONS.casl },
    args: {
      ...globalArgs,
      action: {
        type: "positional",
        required: true,
        description: "import",
      },
      rules: {
        type: "string",
        description:
          "JSON of { [role]: rules }, each role's ability.rules or packRules output",
        valueHint: "file",
      },
      out: { type: "string", description: "File to write", valueHint: "file" },
    },
    async run({ args: parsed }) {
      if (parsed.action !== "import") {
        ctx.report({
          code: 2,
          output: "permdock casl: the action is import\n",
        });
        return;
      }
      // Lazy: the importer loads only when this command runs, not for --help.
      const { runCaslImport } = await import("../importers/casl.ts");
      ctx.report(
        runCaslImport({
          cwd: ctx.cwd,
          rules: stringArg(parsed.rules),
          out: stringArg(parsed.out),
          json: ctx.json,
        }),
      );
    },
  });
}
