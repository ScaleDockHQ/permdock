import { defineCommand } from "citty";

import {
  type CliContext,
  type Command,
  globalArgs,
  listArg,
} from "./context.ts";
import { COMMAND_DESCRIPTIONS } from "./index.ts";
import { ask, CANCELLED } from "./prompt.ts";

export function doctor(ctx: CliContext): Command {
  const command = defineCommand({
    meta: {
      name: "doctor",
      description: COMMAND_DESCRIPTIONS.doctor,
    },
    args: {
      ...globalArgs,
      only: {
        type: "string",
        description: "Check codes or groups to run, repeatable",
        valueHint: "codes",
      },
      fix: {
        type: "boolean",
        description: "Apply safe fixes: install skills, regenerate the catalog",
      },
      strict: { type: "boolean", description: "Exit 1 on warnings too" },
    },
    async run({ args: parsed, rawArgs }) {
      let fix = parsed.fix === true;
      if (fix && ctx.interactive) {
        const answer = await ask(
          `Install the Agent Skills and regenerate the catalog in ${ctx.cwd}?`,
        );
        if (answer === undefined) {
          ctx.report(CANCELLED);
          return;
        }
        fix = answer;
      }
      // Lazy: the implementation loads only when this command runs, not for --help.
      const result = await (
        await import("../doctor.ts")
      ).runDoctor({
        cwd: ctx.cwd,
        config: ctx.config,
        only: listArg(rawArgs, "only"),
        json: ctx.json,
        fix,
        strict: parsed.strict === true,
        color: ctx.color,
        now: ctx.now,
        io: ctx.io,
      });
      ctx.report(result);
    },
  });
  return command;
}
