import type { Leaf } from "../core/command.ts";

import { defineLeaf } from "../core/command.ts";
import { usageResult } from "../core/errors.ts";
import {
  checkFlag,
  dryRunFlag,
  given,
  outFlag,
  policyFlag,
} from "../core/flags.ts";
import { requirePolicy } from "../project/load.ts";

export const policyBundle: Leaf = defineLeaf({
  flags: {
    ...policyFlag,
    kind: {
      type: "enum",
      options: ["bundle", "sql"],
      default: "bundle",
      description:
        "What to print: the bundle JSON, or the SQL that loads it into the database",
    },
    ...outFlag,
    ...checkFlag,
    ...dryRunFlag,
  },
  async run(ctx, { flags }) {
    try {
      // Lazy: the implementation loads only when this command runs, not for --help.
      const { runPolicyBundle } = await import("../policy-bundle.ts");
      const policy = await requirePolicy(
        ctx.cwd,
        given(flags.policy) ?? ctx.config.policy,
        "set policy in permdock.config.ts or pass --policy",
      );
      return runPolicyBundle({
        cwd: ctx.cwd,
        config: ctx.config,
        policy,
        kind: flags.kind,
        out: given(flags.out === "-" ? "" : flags.out),
        check: flags.check,
        dryRun: flags["dry-run"],
      });
    } catch (error) {
      return usageResult(error);
    }
  },
});
