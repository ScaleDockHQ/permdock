import type { Leaf } from "../core/command.ts";

import { defineLeaf } from "../core/command.ts";
import { usageResult } from "../core/errors.ts";
import { given, policyFlag } from "../core/flags.ts";
import { requirePolicy } from "../project/load.ts";

function count(value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new TypeError(
      `PermDock CLI: '${value}' is not a non-negative integer`,
    );
  }
  return parsed;
}

export const snapshotSize: Leaf = defineLeaf({
  flags: {
    ...policyFlag,
    role: {
      type: "string",
      description: "Role to measure (default the role with the most grants)",
      valueHint: "name",
    },
    tenants: {
      type: "string",
      description: "Memberships of a scoped role (default 1)",
      valueHint: "count",
    },
    "omit-assignable": {
      type: "boolean",
      description: "Measure with the assignable part left out",
    },
    "omit-static": {
      type: "boolean",
      description:
        "Measure with the grants of declared roles replaced by bundle references",
    },
    budget: {
      type: "string",
      description: "Bytes the total may weigh (default 65536)",
      valueHint: "bytes",
    },
  },
  async run(ctx, { flags }) {
    try {
      // Lazy: the implementation loads only when this command runs, not for --help.
      const { runSnapshotSize, SNAPSHOT_BUDGET_BYTES } =
        await import("../snapshot-size.ts");
      const path = given(flags.policy) ?? ctx.config.policy;
      const policy = await requirePolicy(
        ctx.cwd,
        path,
        "set policy in permdock.config.ts or pass --policy",
      );
      return runSnapshotSize({
        policy,
        role: given(flags.role),
        tenants: count(flags.tenants, 1),
        omitAssignable: flags["omit-assignable"],
        omitStatic: flags["omit-static"],
        budget: count(flags.budget, SNAPSHOT_BUDGET_BYTES),
        json: ctx.json,
      });
    } catch (error) {
      return usageResult(error);
    }
  },
});

export const claimsSize: Leaf = defineLeaf({
  flags: {
    memberships: {
      type: "string",
      description: "Memberships the user holds (default 11)",
      valueHint: "count",
    },
    roles: {
      type: "string",
      description: "Roles in each membership (default 1)",
      valueHint: "count",
    },
    scope: {
      type: "string",
      description: "Scope name written in each entry (default organization)",
      valueHint: "name",
    },
    budget: {
      type: "string",
      description: "Byte budget of the memberships claim (default 1024)",
      valueHint: "bytes",
    },
  },
  async run(ctx, { flags }) {
    try {
      // Lazy: the implementation loads only when this command runs, not for --help.
      const { runClaimsSize } = await import("../claims-size.ts");
      return runClaimsSize({
        memberships: count(flags.memberships, 11),
        roles: count(flags.roles, 1),
        scope: given(flags.scope) ?? "organization",
        budget:
          flags.budget === undefined || flags.budget === ""
            ? undefined
            : count(flags.budget, 0),
        json: ctx.json,
      });
    } catch (error) {
      return usageResult(error);
    }
  },
});
