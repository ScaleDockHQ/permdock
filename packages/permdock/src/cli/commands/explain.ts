import type { Leaf } from "../core/command.ts";

import { defineLeaf } from "../core/command.ts";
import { usageResult } from "../core/errors.ts";
import { given, policyFlag } from "../core/flags.ts";
import { requirePolicy } from "../project/load.ts";

export const explain: Leaf = defineLeaf({
  positionals: [
    {
      name: "action",
      description: "The permission key to explain, such as post.update",
      required: true,
    },
  ],
  flags: {
    ...policyFlag,
    fixtures: {
      type: "string",
      description:
        "Fixtures file (default rls.fixtures in the config, else rls.fixtures.json)",
      valueHint: "file",
    },
  },
  async run(ctx, { flags, args }) {
    try {
      // Lazy: the implementation loads only when this command runs, not for --help.
      const { runExplain } = await import("../explain.ts");
      const policy = await requirePolicy(
        ctx.cwd,
        given(flags.policy) ?? ctx.config.policy,
        "set policy in permdock.config.ts or pass --policy",
      );
      return await runExplain({
        cwd: ctx.cwd,
        policy,
        action: args["action"] ?? "",
        fixtures:
          given(flags.fixtures) ??
          ctx.config.rls?.fixtures ??
          "rls.fixtures.json",
        json: ctx.json,
        now: ctx.now,
      });
    } catch (error) {
      return usageResult(error);
    }
  },
});
