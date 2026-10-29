import type { Leaf } from "../core/command.ts";

import { defineLeaf } from "../core/command.ts";
import { dbUrl, dbUrlFlags, failOnFlag } from "../core/flags.ts";
import { ask, CANCELLED } from "../core/prompt.ts";

export const doctor: Leaf = defineLeaf({
  flags: {
    only: {
      type: "string",
      repeatable: true,
      description: "Check codes or groups to run",
      valueHint: "code",
      async complete() {
        // Lazy: the checks load only when completion asks for them, not for every run.
        const { DOCTOR_CHECKS } = await import("../doctor/doctor.ts");
        return [
          ...new Set([
            ...DOCTOR_CHECKS.map(({ code }) => code),
            ...DOCTOR_CHECKS.flatMap(({ groups }) => groups),
          ]),
        ];
      },
    },
    fix: {
      type: "boolean",
      description: "Apply safe fixes: install skills, regenerate the catalog",
    },
    ...failOnFlag,
    ...dbUrlFlags,
  },
  async run(ctx, { flags }) {
    const db = await dbUrl(ctx, flags);
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
      ...(db === undefined ? {} : { db }),
    });
  },
});
