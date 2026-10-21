import { describe, expect, it } from "vitest";

import { moveConfigKeys } from "../../src/cli/codemod/config-moves.ts";
import { CONFIG_MOVES_0_8 } from "../../src/cli/codemod/renames-0.8.ts";

const move = (source: string) =>
  moveConfigKeys("permdock.config.ts", source, CONFIG_MOVES_0_8);

describe(moveConfigKeys, () => {
  it("moves the tenant and team shorthands to the named-scope forms", () => {
    const result = move(`import { defineConfig } from "permdock/cli";

export default defineConfig({
  policy: "./src/policy.ts",
  rls: {
    tenantType: "text",
    teamType: "uuid",
    memberships: {
      tenant: { table: "members", tenant: "org_id", user: "user_id", role: "role" },
      team: { table: "team_members", team: "team_id", tenant: "org_id", user: "user_id", role: "role" },
    },
  },
});
`);
    expect(result.source).toBe(`import { defineConfig } from "permdock/cli";

export default defineConfig({
  policy: "./src/policy.ts",
  rls: {
    scopeTypes: { tenant: "text", team: "uuid" },
    memberships: {
      scopes: { tenant: { table: "members", columns: { tenant: "org_id" }, user: "user_id", role: "role" }, team: { table: "team_members", columns: { tenant: "org_id", team: "team_id" }, user: "user_id", role: "role" } },
    },
  },
});
`);
    expect(
      result.changes.map((change) => `${change.from} → ${change.to}`),
    ).toStrictEqual([
      "rls.tenantType → rls.scopeTypes.tenant",
      "rls.teamType → rls.scopeTypes.team",
      "rls.memberships.tenant → rls.memberships.scopes.tenant",
      "rls.memberships.team → rls.memberships.scopes.team",
      "rls.memberships.scopes.tenant.tenant → rls.memberships.scopes.tenant.columns.tenant",
      "rls.memberships.scopes.team.tenant → rls.memberships.scopes.team.columns.tenant",
      "rls.memberships.scopes.team.team → rls.memberships.scopes.team.columns.team",
    ]);
    expect(result.followUps).toStrictEqual([]);
  });

  it("merges into an existing object and reports a key already set", () => {
    const result = move(`export default {
  rls: { scopeTypes: { tenant: "uuid" }, tenantType: "text", teamType: "int8" },
};
`);
    expect(result.source).toBe(`export default {
  rls: { scopeTypes: { tenant: "uuid", team: "int8" }, tenantType: "text" },
};
`);
    expect(result.followUps).toMatchObject([
      {
        name: "rls.tenantType",
        message:
          "rls.tenantType moved to rls.scopeTypes.tenant, which is already set; merge it by hand",
      },
    ]);
  });

  it("leaves objects that are not a config alone", () => {
    const source = `export const rls = { tenantType: "text" };\n`;
    expect(move(source).source).toBe(source);
  });
});
