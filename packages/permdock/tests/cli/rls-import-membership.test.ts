import { describe, expect, it } from "vitest";

import type { RlsMemberships } from "../../src/cli/types.ts";

import { conditionFromAst } from "../../src/cli/rls/import-ast.ts";
import { mapRoleValues } from "../../src/cli/rls/import-membership.ts";
import { textArrayLiteral } from "../../src/cli/sql/quote.ts";

const memberships: RlsMemberships = {
  tenant: {
    table: "org_members",
    user: "user_id",
    role: "role",
    tenant: "tenant_id",
    disabledAt: "disabled_at",
    expiresAt: "expires_at",
  },
  team: {
    table: "team_members",
    user: "user_id",
    role: { through: "roles", on: { role_id: "id" }, column: "key" },
    team: "team_id",
  },
};

async function imported(sql: string): Promise<unknown> {
  return conditionFromAst(sql, memberships, undefined, []);
}

const ORG = (where: string) =>
  `exists (select 1 from org_members m where ${where})`;

describe("rls import membership subqueries", () => {
  it.each([
    [
      "an active-row filter",
      ORG(
        "m.tenant_id = docs.org_id and m.user_id = auth.uid() and m.disabled_at is null",
      ),
      [],
    ],
    [
      "the row column on the left and the user on the right",
      ORG("docs.org_id = m.tenant_id and auth.uid() = m.user_id"),
      [],
    ],
    [
      "the current_setting user id",
      ORG(
        "m.tenant_id = docs.org_id and m.user_id = current_setting('app.user_id')",
      ),
      [],
    ],
    [
      "a role literal on the left",
      ORG(
        "m.tenant_id = docs.org_id and m.user_id = auth.uid() and 'owner' = m.role",
      ),
      ["owner"],
    ],
    [
      "roles as = any(array[...])",
      ORG(
        "m.tenant_id = docs.org_id and m.user_id = auth.uid() and m.role = any(array['owner', 'admin'])",
      ),
      ["owner", "admin"],
    ],
    [
      "enum casts on a role literal and an array",
      ORG(
        "m.tenant_id = docs.org_id and m.user_id = auth.uid() and m.role = 'owner'::app_role and m.role = any(array['owner']::app_role[])",
      ),
      ["owner"],
    ],
  ])("imports %s as memberOf", async (_label, sql, roles) => {
    expect(await imported(sql)).toEqual({
      op: "memberOf",
      scope: "tenant",
      field: "org_id",
      roles,
    });
  });

  it("imports the any form with its outer column as the field", async () => {
    expect(
      await imported(
        '"org_id" = any (select tenant_id from org_members where user_id = auth.uid())',
      ),
    ).toEqual({ op: "memberOf", scope: "tenant", field: "org_id", roles: [] });
  });

  it.each([
    [
      "a not-null test",
      ORG(
        "m.tenant_id = docs.org_id and m.user_id = auth.uid() and m.disabled_at is not null",
      ),
    ],
    [
      "a null test on another column",
      ORG(
        "m.tenant_id = docs.org_id and m.user_id = auth.uid() and m.note is null",
      ),
    ],
    [
      "another operator",
      ORG(
        "m.tenant_id = docs.org_id and m.user_id = auth.uid() and m.role <> 'guest'",
      ),
    ],
    [
      "an in list on another column",
      ORG(
        "m.tenant_id = docs.org_id and m.user_id = auth.uid() and m.kind in ('a', 'b')",
      ),
    ],
    [
      "an any array with a non-literal",
      ORG(
        "m.tenant_id = docs.org_id and m.user_id = auth.uid() and m.role = any(array['owner', m.kind])",
      ),
    ],
    [
      "an any over a subquery",
      ORG(
        "m.tenant_id = docs.org_id and m.user_id = auth.uid() and m.role = any(select r from roles r)",
      ),
    ],
    [
      "an in list with a number",
      ORG(
        "m.tenant_id = docs.org_id and m.user_id = auth.uid() and m.role in ('owner', 2)",
      ),
    ],
    [
      "two correlations to different row columns",
      ORG(
        "m.tenant_id = docs.org_id and m.tenant_id = docs.parent_id and m.user_id = auth.uid()",
      ),
    ],
    ["no where clause", "exists (select 1 from org_members)"],
    [
      "a role filter on a table whose role goes through another table",
      "exists (select 1 from team_members t where t.team_id = docs.team_id and t.user_id = auth.uid() and t.role = 'lead')",
    ],
    [
      "an in form whose correlation names another column",
      '"org_id" in (select tenant_id from org_members m where m.user_id = auth.uid() and m.tenant_id = docs.parent_id)',
    ],
    [
      "an in form returning two columns",
      '"org_id" in (select tenant_id, user_id from org_members where user_id = auth.uid())',
    ],
  ])("keeps %s opaque", async (_label, sql) => {
    expect(await imported(sql)).toMatchObject({ op: "opaque" });
  });
});

describe("mapRoleValues", () => {
  it("renames memberOf roles anywhere in a condition and leaves other values", () => {
    expect(
      mapRoleValues(
        {
          op: "or",
          conditions: [
            {
              op: "memberOf",
              scope: "tenant",
              field: "org_id",
              roles: ["org_admin", "member"],
            },
            { op: "eq", field: "role", value: "org_admin" },
          ],
        },
        { org_admin: "owner" },
      ),
    ).toEqual({
      op: "or",
      conditions: [
        {
          op: "memberOf",
          scope: "tenant",
          field: "org_id",
          roles: ["owner", "member"],
        },
        { op: "eq", field: "role", value: "org_admin" },
      ],
    });
  });
});

describe("textArrayLiteral", () => {
  it("quotes an empty element and one that reads as null", () => {
    expect(textArrayLiteral(["", "NULL", "ok"])).toBe(`'{"","NULL",ok}'`);
  });
});
