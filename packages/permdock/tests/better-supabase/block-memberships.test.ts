import { describe, expect, it } from "vitest";

import type { SqlQuery } from "../../src/supabase/sources.ts";

import { blockMembershipSource } from "../../src/better-supabase/block-memberships.ts";
import { testMembershipSource } from "../../src/testing/conformance/identity.ts";

const rows = [
  { user_id: "u1", scope: "organization", id: "o1", roles: ["owner"] },
  {
    user_id: "u2",
    scope: "organization",
    id: "o1",
    roles: ["billing", "member"],
  },
];

const query: SqlQuery = async (text, values) => ({
  rows: text.includes('where m."user_id"')
    ? rows.filter((row) => row.user_id === values[0])
    : rows.filter((row) => row.scope === values[0] && row.id === values[1]),
});

describe("blockMembershipSource conformance", () => {
  testMembershipSource(blockMembershipSource({ query }), {
    principals: [{ id: "u1" }, { id: "u2" }, { id: "u3" }],
    expect: {
      u1: [{ scope: "organization", id: "o1", roles: ["owner"] }],
      u2: [{ scope: "organization", id: "o1", roles: ["billing", "member"] }],
      u3: [],
    },
  });
});

describe(blockMembershipSource, () => {
  it("reads the block's table and columns by default", () => {
    const { sql } = blockMembershipSource();
    expect(sql.table).toBe("better_supabase.memberships");
    expect(sql.scope).toBe("organization");
    const select = sql.select("$1");
    expect(select).toContain('"better_supabase"."memberships"');
    expect(select).toContain('m."organization_id"');
    expect(select).toContain('m."role"');
    expect(select).toContain('m."disabled_at" is null');
    expect(sql.manifest).toMatchObject({
      scope: { value: "organization" },
      id: { column: "organization_id" },
      role: { column: "role" },
      disabledAt: { column: "disabled_at" },
    });
  });

  it("follows the block's column map and drops disabledAt when null", () => {
    const { sql } = blockMembershipSource({
      table: "public.org_members",
      scope: "tenant",
      columns: {
        tenant: "tenant_id",
        user: "member_id",
        role: "role_key",
        disabledAt: null,
      },
    });
    const select = sql.select("$1");
    expect(select).toContain('m."tenant_id"');
    expect(select).toContain('m."member_id"');
    expect(select).toContain('m."role_key"');
    expect(select).not.toContain("disabled_at");
  });

  it("resolves custom roles through roleThrough", () => {
    const { sql } = blockMembershipSource({
      roleThrough: { table: "public.roles", id: "id", column: "key" },
    });
    expect(sql.select("$1")).toContain(
      'join "public"."roles" mk on mk."id" = m."role"',
    );
    expect(sql.through).toMatchObject({
      table: "public.roles",
      id: "id",
      key: "key",
      ref: "role",
    });
  });

  it("reads several roles per membership from a junction", () => {
    const { sql } = blockMembershipSource({
      roles: {
        table: "public.membership_roles",
        membership: "membership_id",
        role: "role",
      },
    });
    expect(sql.select("$1")).toContain(
      'join "public"."membership_roles" mk on mk."membership_id" = m."id"',
    );
    expect(sql.manifest).toMatchObject({
      role: {
        column: "id",
        through: {
          table: "public.membership_roles",
          id: "membership_id",
          column: "role",
        },
      },
    });
  });

  it("refuses roles and roleThrough together", () => {
    expect(() =>
      blockMembershipSource({
        roleThrough: { table: "roles", id: "id", column: "key" },
        roles: { table: "membership_roles", membership: "m", role: "r" },
      }),
    ).toThrow(/roles or roleThrough/u);
  });
});
