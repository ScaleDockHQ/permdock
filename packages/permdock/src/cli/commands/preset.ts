import { defineCommand } from "citty";

import { type CliContext, type Command, globalArgs } from "./context.ts";
import { COMMAND_DESCRIPTIONS } from "./index.ts";

export function preset(ctx: CliContext): Command {
  return defineCommand({
    meta: { name: "preset", description: COMMAND_DESCRIPTIONS.preset },
    args: {
      ...globalArgs,
      action: {
        type: "positional",
        required: false,
        description: "decode or url",
      },
      code: {
        type: "positional",
        required: false,
        description: "The preset code",
      },
    },
    async run({ args: parsed }) {
      const { runPreset } = await import("../init.ts");
      ctx.report(runPreset(parsed._[0], parsed._[1], ctx.json));
    },
  });
}
