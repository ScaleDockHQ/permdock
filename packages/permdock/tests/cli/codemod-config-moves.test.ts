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

  it("reports a target under a value that is not an object literal, and skips a file that does not parse", () => {
    const result = move(`import { defineConfig } from "permdock/cli";
const scopes = {};
export default defineConfig({
  rls: { memberships: { scopes, tenant: { table: "m" } } },
});
`);
    expect(result.changes).toStrictEqual([]);
    expect(result.followUps).toMatchObject([
      {
        line: 4,
        name: "rls.memberships.tenant",
        message:
          "rls.memberships.tenant moved to rls.memberships.scopes.tenant, which is not an object literal; merge it by hand",
      },
    ]);
    expect(move("export default {").changes).toStrictEqual([]);
  });

  it("removes a moved key from the middle, the end or an object of one, and unwraps satisfies", () => {
    const result = move(`export default ({
  rls: {
    scopeTypes: { org: "uuid" },
    tenantType: "text",
    dialect: "supabase",
    memberships: { scopes: { org: { table: "m" } }, team: { table: "t" } },
  },
} satisfies object);
`);
    expect(result.source).toBe(`export default ({
  rls: {
    scopeTypes: { org: "uuid", tenant: "text" },
    dialect: "supabase",
    memberships: { scopes: { org: { table: "m" }, team: { table: "t" } } },
  },
} satisfies object);
`);
    expect(
      move(`export default { rls: { scopeTypes: {}, teamType: "int8" } };\n`)
        .source,
    ).toBe(`export default { rls: { scopeTypes: { team: "int8" } } };\n`);
  });

  it("skips spread and computed keys under a wildcard and appends after a trailing comma", () => {
    const result = move(`const base = {};
export default {
  rls: {
    scopeTypes: { org: "uuid", },
    tenantType: "text",
    memberships: { scopes: { ...base, ["x"]: {}, org: { table: "m", tenant: "org_id" } } },
  },
};
`);
    expect(result.source).toBe(`const base = {};
export default {
  rls: {
    scopeTypes: { org: "uuid", tenant: "text", },
    memberships: { scopes: { ...base, ["x"]: {}, org: { table: "m", columns: { tenant: "org_id" } } } },
  },
};
`);
  });

  it("reports a move onto one of its own ancestors", () => {
    const result = moveConfigKeys(
      "permdock.config.ts",
      "export default { rls: { a: { b: 1 } } };\n",
      [{ from: ["rls", "a", "b"], to: ["rls"] }],
    );
    expect(result.followUps).toMatchObject([
      { name: "rls.a.b", message: "rls.a.b moved to rls; move it by hand" },
    ]);
  });

  it("leaves objects that are not a config alone", () => {
    const source = `export const rls = { tenantType: "text" };\n`;
    expect(move(source).source).toBe(source);
  });
});
