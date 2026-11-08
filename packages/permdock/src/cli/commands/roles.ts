import type { Leaf } from "../core/command.ts";

import { defineLeaf } from "../core/command.ts";
import { usageResult } from "../core/errors.ts";
import { given, policyFlag } from "../core/flags.ts";
import { requirePolicy } from "../project/load.ts";

export const rolesGrants: Leaf = defineLeaf({
  flags: {
    ...policyFlag,
    role: {
      type: "string",
      description: "List one role (default every role)",
      valueHint: "name",
    },
  },
  async run(ctx, { flags }) {
    try {
      // Lazy: the implementation loads only when this command runs, not for --help.
      const { runRoleGrants } = await import("../role-grants.ts");
      const path = given(flags.policy) ?? ctx.config.policy;
      const policy = await requirePolicy(
        ctx.cwd,
        path,
        "set policy in permdock.config.ts or pass --policy",
      );
      return runRoleGrants({ policy, role: given(flags.role), json: ctx.json });
    } catch (error) {
      return usageResult(error);
    }
  },
});
