import { defineCommand } from "citty";

import {
  type CliContext,
  type Command,
  globalArgs,
  stringArg,
} from "./context.ts";
import { COMMAND_DESCRIPTIONS } from "./index.ts";

export function cloud(ctx: CliContext): Command {
  const command = defineCommand({
    meta: {
      name: "cloud",
      description: COMMAND_DESCRIPTIONS.cloud,
    },
    args: {
      ...globalArgs,
      action: { type: "positional", required: false, description: "push" },
      "dry-run": {
        type: "boolean",
        description: "Print the payload; send nothing",
      },
      url: {
        type: "string",
        description: "Cloud API base URL",
        valueHint: "url",
      },
      environment: {
        type: "string",
        description: "Target environment",
        valueHint: "env",
      },
    },
    async run({ args: parsed }) {
      // Lazy: the implementation loads only when this command runs, not for --help.
      const result = await (
        await import("../cloud.ts")
      ).runCloud({
        cwd: ctx.cwd,
        config: ctx.config,
        rest: parsed._,
        url: stringArg(parsed.url),
        environment: stringArg(parsed.environment),
        dryRun: parsed["dry-run"] === true,
        json: ctx.json,
        env: ctx.io.env ?? process.env,
        now: ctx.now,
        io: ctx.io,
      });
      ctx.report(result);
    },
  });
  return command;
}
