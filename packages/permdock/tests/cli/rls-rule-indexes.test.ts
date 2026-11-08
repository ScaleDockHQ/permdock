import { describe, expect, it } from "vitest";

import { ruleIndexTargets } from "../../src/cli/rls/rule-indexes.ts";
import { definePermissions, definePolicy, resource } from "../../src/index.ts";

const permissions = definePermissions({
  job: resource({
    actions: ["read"],
    parent: { field: "managerId", resource: "job" },
  }),
});
const policy = definePolicy(permissions, { subject: () => null });

describe(ruleIndexTargets, () => {
  it("indexes the follows keys, the walk columns and the manager edges", () => {
    const targets = ruleIndexTargets(policy, {
      tables: {
        job: {
          table: "public.jobs",
          follows: { "public.job_parties": "job_id" },
          walk: "recursive",
          user: "ownerId",
        },
      },
      managers: {
        table: "public.reporting_lines",
        user: "employee_id",
        manager: "manager_id",
        tenant: "organization_id",
      },
    });
    expect(
      targets.map((target) => [target.table, ...target.columns].join(" ")),
    ).toStrictEqual([
      "public.job_parties job_id",
      "public.jobs managerId",
      "public.jobs ownerId",
      "public.reporting_lines employee_id organization_id",
      "public.reporting_lines manager_id organization_id",
    ]);
  });

  it("writes none without rules", () => {
    expect(ruleIndexTargets(policy, {})).toStrictEqual([]);
  });
});
