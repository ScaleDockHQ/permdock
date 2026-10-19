import { type Leaf, defineLeaf } from "../core/command.ts";
import { failOnFlag } from "../core/flags.ts";
import { ask, CANCELLED } from "../core/prompt.ts";

export const doctor: Leaf = defineLeaf({
  flags: {
    only: {
      type: "string",
      repeatable: true,
      description: "Check codes or groups to run",
      valueHint: "code",
    },
    fix: {
      type: "boolean",
      description: "Apply safe fixes: install skills, regenerate the catalog",
    },
    ...failOnFlag,
  },
  async run(ctx, { flags }) {
    let fix = flags.fix;
    if (fix && ctx.interactive && !ctx.yes) {
      const answer = await ask(
        `Install the Agent Skills and regenerate the catalog in ${ctx.cwd}?`,
      );
      if (answer === undefined) {
        return CANCELLED;
      }
      fix = answer;
    }
    // Lazy: the implementation loads only when this command runs, not for --help.
    return (await import("../doctor/doctor.ts")).runDoctor({
      cwd: ctx.cwd,
      config: ctx.config,
      only: flags.only,
      json: ctx.json,
      fix,
      strict: flags["fail-on"] === "warning",
      color: ctx.color,
      now: ctx.now,
      io: ctx.io,
    });
  },
});
