import type { Leaf } from "../core/command.ts";

import { defineLeaf } from "../core/command.ts";
import { configError } from "../core/errors.ts";
import { dbUrl, dbUrlFlags } from "../core/flags.ts";
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
    ignore: {
      type: "string",
      repeatable: true,
      description: "Finding ids to accept for this run, as code:target",
      valueHint: "id",
    },
    fix: {
      type: "boolean",
      description: "Apply safe fixes: install skills, regenerate the catalog",
    },
    "update-baseline": {
      type: "boolean",
      description:
        "Rewrite doctor.baseline to accept this run's errors and warnings, keeping each reason",
    },
    "fail-on": {
      type: "enum",
      options: ["error", "warning"],
      description:
        "Lowest finding severity that exits 1 (default doctor.failOn, else error)",
    },
    ...dbUrlFlags,
  },
  async run(ctx, { flags }) {
    const failOn = flags["fail-on"] ?? ctx.config.doctor?.failOn ?? "error";
    if (failOn !== "error" && failOn !== "warning") {
      throw configError(
        `PermDock CLI: doctor.failOn must be "error" or "warning", not ${JSON.stringify(failOn)}`,
      );
    }
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
      ignore: flags.ignore,
      updateBaseline: flags["update-baseline"],
      json: ctx.json,
      fix,
      strict: failOn === "warning",
      color: ctx.color,
      now: ctx.now,
      io: ctx.io,
      ...(db === undefined ? {} : { db }),
    });
  },
});
