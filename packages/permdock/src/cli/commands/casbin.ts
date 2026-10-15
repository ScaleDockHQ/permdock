import { defineCommand } from "citty";

import {
  type CliContext,
  type Command,
  globalArgs,
  stringArg,
} from "./context.ts";
import { COMMAND_DESCRIPTIONS } from "./index.ts";

export function casbin(ctx: CliContext): Command {
  return defineCommand({
    meta: { name: "casbin", description: COMMAND_DESCRIPTIONS.casbin },
    args: {
      ...globalArgs,
      action: {
        type: "positional",
        required: true,
        description: "import",
      },
      model: {
        type: "string",
        description: "The Casbin model.conf",
        valueHint: "file",
      },
      policy: {
        type: "string",
        description: "The Casbin policy.csv",
        valueHint: "file",
      },
      out: { type: "string", description: "File to write", valueHint: "file" },
    },
    async run({ args: parsed }) {
      if (parsed.action !== "import") {
        ctx.report({
          code: 2,
          output: "permdock casbin: the action is import\n",
        });
        return;
      }
      // Lazy: the importer loads only when this command runs, not for --help.
      const { runCasbinImport } = await import("../importers/casbin.ts");
      ctx.report(
        runCasbinImport({
          cwd: ctx.cwd,
          model: stringArg(parsed.model),
          policy: stringArg(parsed.policy),
          out: stringArg(parsed.out),
          json: ctx.json,
        }),
      );
    },
  });
}
