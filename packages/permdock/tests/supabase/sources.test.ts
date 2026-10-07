import { describe, expect, it } from "vitest";

import type { SqlQuery } from "../../src/supabase/sources.ts";

import {
  authzVersion,
  fromJunction,
  fromSupabasePostgres,
  fromTable,
} from "../../src/supabase/sources.ts";
import { testMembershipSource } from "../../src/testing/conformance.ts";

type Call = { readonly text: string; readonly values: readonly unknown[] };

function recording(
  rows: readonly Record<string, unknown>[],
  shape: "array" | "result" = "result",
): { readonly query: SqlQuery; readonly calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    query: async (text, values) => {
      calls.push({ text, values });
      return shape === "array" ? rows : { rows };
    },
  };
}

const principal = { id: "u1", roles: [] };

const tableRows = [
  { user_id: "u1", scope: "tenant", id: "o1", roles: ["admin"] },
  { user_id: "u2", scope: "tenant", id: "o1", roles: ["member"] },
];

const tableQuery: SqlQuery = async (text, values) => ({
  rows: text.includes('where m."user_id"')
    ? tableRows.filter((row) => row.user_id === values[0])
    : tableRows.filter(
        (row) => row.scope === values[0] && row.id === values[1],
      ),
});

describe("fromTable conformance", () => {
  testMembershipSource(fromTable({ table: "memberships", query: tableQuery }), {
    principals: [{ id: "u1" }, { id: "u2" }, { id: "u3" }],
    expect: {
      u1: [{ scope: "tenant", id: "o1", roles: ["admin"] }],
      u2: [{ scope: "tenant", id: "o1", roles: ["member"] }],
      u3: [],
    },
  });
});

describe("fromTable", () => {
  it("selects one row per instance with the default columns", () => {
    const { sql } = fromTable({ table: "memberships" });
    expect(sql.table).toBe("memberships");
    expect(sql.user).toBe("user_id");
    expect(sql.columns).toEqual(["user_id", "scope", "scope_id", "role"]);
    expect(sql.reads).toEqual([]);
    expect(sql.select("$1"))
      .toBe(`select m."scope"::text as scope, m."scope_id"::text as id, null::jsonb as within, jsonb_agg(distinct m."role"::text order by m."role"::text) as roles, null::text as via, null::bigint as expires_at, null::text as granted_by, null::text as reason, null::text as member_group, null::text as managed_by, null::jsonb as seats
from "public"."memberships" m
where m."user_id" = $1
group by m."scope"::text, m."scope_id"::text`);
    expect(sql.list()).toContain(
      'where m."scope"::text = $1::text and m."scope_id"::text = $2::text',
    );
    expect(sql.list()).toMatch(/^select m."user_id"::text as user_id, /u);
    expect(sql.manifest).toEqual({
      table: "public.memberships",
      user: { column: "user_id" },
      scope: { column: "scope" },
      id: { column: "scope_id" },
      role: { column: "role" },
      columns: ["user_id", "scope", "scope_id", "role"],
    });
  });

  it("maps every optional column and applies expiry and suspension filters", () => {
    const { sql } = fromTable({
      table: "auth_ext.members",
      columns: {
        user: "uid",
        scope: "kind",
        id: "ref",
        within: "parents",
        role: "role_name",
        via: "source",
        expiresAt: "ends_at",
        grantedBy: "granted_by",
        reason: "why",
        group: "squad",
        managedBy: "owner",
        seats: "seats",
      },
      suspension: {
        users: { table: "profiles", id: "id", disabledAt: "banned_at" },
        scopes: {
          tenant: {
            table: "orgs",
            id: "id",
            status: "state",
            active: ["active", "o'k"],
          },
        },
      },
    });
    const select = sql.select("$1");
    expect(select).toContain('from "auth_ext"."members" m');
    expect(select).toContain('m."parents" as within');
    expect(select).toContain(
      'floor(extract(epoch from m."ends_at"))::bigint as expires_at',
    );
    expect(select).toContain('to_jsonb(m."seats") as seats');
    expect(select).toContain('(m."ends_at" is null or m."ends_at" > now())');
    expect(select).toContain(
      'exists (select 1 from "public"."profiles" s where s."id"::text = (m."uid")::text and s."banned_at" is null)',
    );
    expect(select).toContain(
      `s."state"::text = any(array['active', 'o''k']::text[])`,
    );
    expect(select).toContain(
      `coalesce(case when m."kind"::text = 'tenant' then m."ref"::text end, m."parents" ->> 'tenant')`,
    );
    expect(sql.reads).toEqual(["profiles", "orgs"]);
    expect(sql.managed).toBe("owner");
    expect(sql.columns).toEqual([
      "uid",
      "kind",
      "ref",
      "role_name",
      "parents",
      "source",
      "ends_at",
    ]);
    expect(sql.manifest).toMatchObject({
      within: { column: "parents" },
      via: { column: "source" },
      expiresAt: { column: "ends_at" },
    });
  });

  it("turns rows into memberships and drops rows it cannot read", async () => {
    const { query, calls } = recording([
      {
        scope: "tenant",
        id: "o1",
        roles: ["member", "admin", "", 3],
        within: { root: "r1", bad: 7 },
        via: "invite",
        expires_at: "1900000000",
        granted_by: "u9",
        reason: "onboarding",
        member_group: "ops",
        managed_by: "idp",
        seats: ["pro"],
      },
      { scope: "team", id: "t1", roles: ["lead"], within: [], expires_at: 12 },
      { scope: "team", id: "t2", roles: [] },
      { scope: "team", id: 3, roles: ["lead"] },
      { scope: "team", id: "t3", roles: "lead", expires_at: "" },
    ]);
    const source = fromTable({ table: "memberships", query });
    expect(await source.membershipsFor(principal, {})).toEqual([
      {
        scope: "tenant",
        id: "o1",
        within: { root: "r1" },
        roles: ["admin", "member"],
        via: "invite",
        expiresAt: 1_900_000_000,
        grantedBy: "u9",
        reason: "onboarding",
        member: { group: "ops" },
        managedBy: "idp",
        entitlements: ["pro"],
      },
      { scope: "team", id: "t1", roles: ["lead"], expiresAt: 12 },
    ]);
    expect(calls[0]?.values).toEqual(["u1"]);
  });

  it("lists the members of one instance from a plain row array", async () => {
    const { query, calls } = recording(
      [
        { user_id: "u1", scope: "tenant", id: "o1", roles: ["member"] },
        { user_id: 7, scope: "tenant", id: "o1", roles: ["member"] },
      ],
      "array",
    );
    const source = fromTable({ table: "memberships", query });
    expect(await source.list?.({ scope: "tenant", id: "o1" })).toEqual([
      {
        principal: { id: "u1" },
        membership: { scope: "tenant", id: "o1", roles: ["member"] },
      },
    ]);
    expect(calls[0]?.values).toEqual(["tenant", "o1"]);
  });

  it("describes SQL without a query and refuses to resolve", async () => {
    const source = fromTable({ table: "memberships" });
    await expect(source.membershipsFor(principal, {})).rejects.toThrow(
      "the memberships membership source needs query to resolve memberships",
    );
  });

  it.each([
    [
      { table: "members; drop table x" },
      "unsafe SQL identifier 'members; drop table x'",
    ],
    [
      { table: "m", columns: { role: 'role"' } },
      `unsafe SQL identifier 'role"'`,
    ],
    [
      { table: "m", suspension: { users: { table: "p", id: "id" } } },
      "a suspension table needs disabledAt or status",
    ],
    [
      {
        table: "m",
        suspension: { users: { table: "p", id: "id", status: "state" } },
      },
      "a suspension status column needs its active values",
    ],
  ])("rejects %j", (options, message) => {
    expect(() => fromTable(options).sql.select("$1")).toThrow(message);
  });
});

describe("fromJunction", () => {
  it("reads a one-scope table with a role column and ancestor columns", async () => {
    const { query, calls } = recording([
      {
        scope: "project",
        id: "p1",
        roles: ["editor"],
        within: { tenant: "o1" },
      },
    ]);
    const source = fromJunction({
      table: "project_members",
      scope: "project",
      roles: "role",
      within: { tenant: "org_id" },
      expiresAt: "until",
      grantedBy: "added_by",
      reason: "note",
      group: { column: "squad" },
      managedBy: { column: "owner" },
      seats: "seats",
      suspension: {
        scopes: {
          tenant: { table: "orgs", id: "id", disabledAt: "closed_at" },
          project: { table: "projects", id: "id", disabledAt: "archived_at" },
          team: { table: "teams", id: "id", disabledAt: "gone_at" },
        },
      },
      query,
    });
    expect(source.sql.scope).toBe("project");
    expect(source.sql.holds).toEqual(["project", "tenant"]);
    expect(source.sql.columns).toEqual([
      "user_id",
      "project_id",
      "org_id",
      "role",
      "until",
    ]);
    const select = source.sql.select("$1");
    expect(select).toContain(`'project'::text as scope`);
    expect(select).toContain(
      `jsonb_build_object('tenant', m."org_id"::text) as within`,
    );
    expect(select).toContain('m."squad"::text as member_group');
    expect(select).toContain('m."owner"::text as managed_by');
    expect(select).toContain('"public"."orgs"');
    expect(select).toContain('"public"."projects"');
    expect(select).not.toContain('"public"."teams"');
    expect(source.sql.list()).toContain(
      `$1::text = 'project' and m."project_id"::text = $2::text`,
    );
    expect(source.sql.manifest).toMatchObject({
      scope: { value: "project" },
      role: { column: "role" },
      within: { columns: { tenant: "org_id" } },
      expiresAt: { column: "until" },
    });
    expect(await source.membershipsFor(principal, {})).toEqual([
      {
        scope: "project",
        id: "p1",
        roles: ["editor"],
        within: { tenant: "o1" },
      },
    ]);
    expect(calls).toHaveLength(1);
  });

  it("gives every row fixed roles, a fixed via, group and identity-provider ownership", () => {
    const { sql } = fromJunction({
      table: "customer_contacts",
      scope: "customer",
      roles: ["contact"],
      via: "contact",
      group: "buyers",
      managedBy: "idp",
    });
    const select = sql.select("$1");
    expect(select).toContain(`jsonb_build_array('contact') as roles`);
    expect(select).toContain(`'contact'::text as via`);
    expect(select).toContain(`'buyers'::text as member_group`);
    expect(select).toContain(`'idp'::text as managed_by`);
    expect(sql.managed).toBe("");
    expect(sql.manifest).toMatchObject({
      role: { value: ["contact"] },
      via: { value: "contact" },
    });
  });

  it.each([
    [{ scope: "Bad Scope", roles: "role" }, "unsafe scope name 'Bad Scope'"],
    [{ scope: "customer", roles: [] }, "fromJunction needs at least one role"],
  ])("rejects %j", (options, message) => {
    expect(() => fromJunction({ table: "contacts", ...options })).toThrow(
      message,
    );
  });
});

describe("fromSupabasePostgres", () => {
  it("runs fromTable lookups through ctx.postgres.queryRaw", async () => {
    const calls: { text: string; params: unknown[] | undefined }[] = [];
    const postgres = {
      queryRaw: async <T = Record<string, unknown>>(
        text: string,
        params?: unknown[],
      ): Promise<T[]> => {
        calls.push({ text, params });
        // SAFETY: the fixture rows are the shape fromTable selects.
        return tableRows as unknown as T[];
      },
    };
    const source = fromTable({
      table: "public.memberships",
      query: fromSupabasePostgres(postgres),
    });
    const memberships = await source.membershipsFor(principal, {});
    expect(memberships.length).toBeGreaterThan(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.params).toEqual(["u1"]);
  });
});

describe("authzVersion", () => {
  it.each([
    [[{ version: 4 }], 4],
    [[{ version: "7" }], 7],
    [[], 0],
    [[{ version: "x" }], undefined],
  ])("reads %j as %s", async (rows, expected) => {
    const { query, calls } = recording(rows);
    const version = authzVersion({ query, schema: "authz" });
    expect(await version(principal)).toBe(expected);
    expect(calls[0]).toEqual({
      text: 'select version from "authz"."permdock_authz_version" where user_id = $1',
      values: ["u1"],
    });
  });
});

describe("a role column through a roles table", () => {
  const through = { through: "roles", on: { role_id: "id" }, column: "key" };

  it("reads fromTable role keys from the roles table", async () => {
    const { query, calls } = recording([
      { scope: "organization", id: "o1", roles: ["admin", "auditor"] },
    ]);
    const source = fromTable({
      table: "identity.memberships",
      columns: { role: through },
      query,
    });
    const select = source.sql.select("$1");
    expect(select).toContain(
      `jsonb_agg(distinct mk."key"::text order by mk."key"::text) as roles`,
    );
    expect(select).toContain(`from "identity"."memberships" m
join "identity"."roles" mk on mk."id" = m."role_id"
where m."user_id" = $1`);
    expect(source.sql.list()).toContain(
      'join "identity"."roles" mk on mk."id" = m."role_id"',
    );
    expect(source.sql.through).toEqual({
      table: "identity.roles",
      id: "id",
      key: "key",
      ref: "role_id",
    });
    expect(source.sql.columns).toEqual([
      "user_id",
      "scope",
      "scope_id",
      "role_id",
    ]);
    expect(source.sql.manifest.role).toEqual({
      column: "role_id",
      through: { table: "identity.roles", id: "id", column: "key" },
    });
    expect(await source.membershipsFor(principal, {})).toEqual([
      { scope: "organization", id: "o1", roles: ["admin", "auditor"] },
    ]);
    expect(calls[0]?.text).toContain('join "identity"."roles" mk');
  });

  it("reads fromJunction role keys from a qualified roles table", () => {
    const source = fromJunction({
      table: "organization_users",
      scope: "organization",
      roles: { ...through, through: "identity.roles" },
      suspension: {
        users: { table: "profiles", id: "user_id", disabledAt: "disabled_at" },
      },
    });
    const select = source.sql.select("$1");
    expect(select).toContain(`from "public"."organization_users" m
join "identity"."roles" mk on mk."id" = m."role_id"`);
    expect(select).toContain('s."disabled_at" is null');
    expect(source.sql.columns).toEqual([
      "user_id",
      "organization_id",
      "role_id",
    ]);
    expect(source.sql.manifest).toMatchObject({
      scope: { value: "organization" },
      role: {
        column: "role_id",
        through: { table: "identity.roles", id: "id", column: "key" },
      },
    });
  });

  it("needs exactly one join column", () => {
    expect(() =>
      fromJunction({
        table: "organization_users",
        scope: "organization",
        roles: { ...through, on: {} },
      }),
    ).toThrow(
      "PermDock: fromJunction roles.on must map exactly one column of public.organization_users to roles",
    );
    expect(() =>
      fromTable({
        table: "memberships",
        columns: { role: { ...through, on: { a: "id", b: "id" } } },
      }),
    ).toThrow("fromTable columns.role.on must map exactly one column");
  });
});

describe("a user column through a profile table", () => {
  const user = {
    through: "contact_profiles",
    on: { contact_profile_id: "id" },
    column: "user_id",
  };
  const suspension = {
    users: { table: "profiles", id: "user_id", disabledAt: "disabled_at" },
    scopes: {
      organization: {
        table: "organizations",
        id: "id",
        disabledAt: "disabled_at",
      },
    },
  };

  it("reads fromJunction users from the profile table", async () => {
    const { query, calls } = recording([
      {
        scope: "customer",
        id: "c1",
        within: { organization: "o1" },
        roles: ["customer"],
        via: "contact",
      },
    ]);
    const source = fromJunction({
      table: "customer_contacts",
      scope: "customer",
      id: "customer_id",
      within: { organization: "organization_id" },
      user,
      roles: ["customer"],
      via: "contact",
      suspension,
      query,
    });
    const select = source.sql.select("$1");
    expect(select).toContain(`from "public"."customer_contacts" m
join "public"."contact_profiles" mu on mu."id" = m."contact_profile_id"
where mu."user_id" = $1`);
    expect(select).toContain(
      `exists (select 1 from "public"."profiles" s where s."user_id"::text = (mu."user_id")::text and s."disabled_at" is null)`,
    );
    expect(select).toContain('s."id"::text = (m."organization_id"::text)');
    expect(source.sql.list()).toContain(`select mu."user_id"::text as user_id`);
    expect(source.sql.list()).toContain(
      `group by mu."user_id", m."customer_id"`,
    );
    expect(source.sql.user).toBe("contact_profile_id");
    expect(source.sql.userThrough).toEqual({
      table: "public.contact_profiles",
      id: "id",
      key: "user_id",
      ref: "contact_profile_id",
    });
    expect(source.sql.userType).toBe(
      '"public"."contact_profiles"."user_id"%type',
    );
    expect(source.sql.columns).toEqual([
      "contact_profile_id",
      "customer_id",
      "organization_id",
    ]);
    expect(source.sql.manifest).toMatchObject({
      user: {
        column: "contact_profile_id",
        through: {
          table: "public.contact_profiles",
          id: "id",
          column: "user_id",
        },
      },
      role: { value: ["customer"] },
    });
    expect(await source.membershipsFor(principal, {})).toEqual([
      {
        scope: "customer",
        id: "c1",
        within: { organization: "o1" },
        roles: ["customer"],
        via: "contact",
      },
    ]);
    expect(calls[0]?.text).toContain('where mu."user_id" = $1');
  });

  it("lists the members a profile table names and skips a profile with no user", async () => {
    const { query } = recording([
      { user_id: "u1", scope: "customer", id: "c1", roles: ["customer"] },
      { user_id: null, scope: "customer", id: "c1", roles: ["customer"] },
    ]);
    const source = fromJunction({
      table: "customer_contacts",
      scope: "customer",
      id: "customer_id",
      user,
      roles: ["customer"],
      query,
    });
    expect(await source.list?.({ scope: "customer", id: "c1" })).toEqual([
      {
        principal: { id: "u1" },
        membership: { scope: "customer", id: "c1", roles: ["customer"] },
      },
    ]);
  });

  it("combines a user and a role through on fromTable", () => {
    const source = fromTable({
      table: "crm.memberships",
      columns: {
        user: { ...user, through: "identity.contact_profiles" },
        role: { through: "roles", on: { role_id: "id" }, column: "key" },
      },
    });
    const select = source.sql.select("$1");
    expect(select).toContain(`from "crm"."memberships" m
join "identity"."contact_profiles" mu on mu."id" = m."contact_profile_id"
join "crm"."roles" mk on mk."id" = m."role_id"
where mu."user_id" = $1`);
    expect(source.sql.columns).toEqual([
      "contact_profile_id",
      "scope",
      "scope_id",
      "role_id",
    ]);
    expect(source.sql.through?.table).toBe("crm.roles");
    expect(source.sql.userThrough?.table).toBe("identity.contact_profiles");
  });

  it("reads the user through a profile table beside several role sources", () => {
    const source = fromJunction({
      table: "customer_contacts",
      scope: "customer",
      id: "customer_id",
      user,
      roles: {
        sources: [
          "tier",
          { through: "roles", on: { role_id: "id" }, column: "key" },
        ],
      },
    });
    const select = source.sql.select("$1");
    expect(select).toContain(
      `join "public"."contact_profiles" mu on mu."id" = m."contact_profile_id"`,
    );
    expect(select).toContain("cross join lateral");
    expect(select).toContain('where mu."user_id" = $1');
    expect(source.sql.columns).toEqual([
      "contact_profile_id",
      "customer_id",
      "tier",
      "role_id",
    ]);
    expect(source.sql.throughs.map((through) => through.table)).toEqual([
      "public.roles",
    ]);
    expect(source.sql.userThrough?.table).toBe("public.contact_profiles");
    expect(source.sql.manifest).toMatchObject({
      user: {
        column: "contact_profile_id",
        through: { table: "public.contact_profiles" },
      },
      role: [
        { column: "tier" },
        { column: "role_id", through: { table: "public.roles" } },
      ],
    });
  });

  it("needs exactly one join column", () => {
    expect(() =>
      fromJunction({
        table: "customer_contacts",
        scope: "customer",
        user: { ...user, on: {} },
        roles: ["customer"],
      }),
    ).toThrow(
      "PermDock: fromJunction user.on must map exactly one column of public.customer_contacts to contact_profiles, for example { contact_profile_id: 'id' }",
    );
    expect(() =>
      fromTable({
        table: "memberships",
        columns: { user: { ...user, on: { a: "id", b: "id" } } },
      }),
    ).toThrow("fromTable columns.user.on must map exactly one column");
  });
});

describe("suspension keep", () => {
  const suspension = {
    scopes: {
      tenant: {
        table: "orgs",
        id: "id",
        disabledAt: "closed_at",
        keep: ["tenant.restore", { key: "tenant.export" }],
      },
      project: { table: "projects", id: "id", disabledAt: "archived_at" },
    },
  };

  it("keeps rows of a suspended instance with the keys they still grant", () => {
    const source = fromJunction({
      table: "project_members",
      scope: "project",
      roles: "role",
      within: { tenant: "org_id" },
      suspension,
    });
    expect(source.sql.keeps).toBe(true);
    const select = source.sql.select("$1");
    const tenant = `(m."org_id"::text is null or exists (select 1 from "public"."orgs" s where s."id"::text = (m."org_id"::text)::text and s."closed_at" is null))`;
    const kept = `(select jsonb_agg(k order by k) from unnest(array['tenant.export', 'tenant.restore']::text[]) k where (${tenant} or k = any(array['tenant.export', 'tenant.restore']::text[])))`;
    expect(select).toContain(
      `(array_agg(case when ${tenant} then null else ${kept} end))[1] as keep`,
    );
    expect(select).toContain(`(${tenant} or ${kept} is not null)`);
    expect(select).toContain('"public"."projects" s');
    expect(source.sql.list()).toContain(" as keep");
  });

  it("adds the keep column only where a source keeps or a union needs it", () => {
    const plain = fromTable({ table: "memberships" });
    expect(plain.sql.keeps).toBe(false);
    expect(plain.sql.select("$1")).not.toContain("keep");
    expect(plain.sql.select("$1", true)).toContain("null::jsonb as keep");
    expect(plain.sql.list(true)).toContain("null::jsonb as keep");
  });

  it("reads keep into the membership and drops a malformed one", async () => {
    const { query } = recording([
      { scope: "tenant", id: "o1", roles: ["owner"], keep: ["tenant.restore"] },
      { scope: "tenant", id: "o2", roles: ["owner"], keep: null },
      { scope: "tenant", id: "o3", roles: ["owner"], keep: "tenant.restore" },
    ]);
    const source = fromTable({ table: "memberships", suspension, query });
    expect(await source.membershipsFor(principal, {})).toEqual([
      { scope: "tenant", id: "o1", roles: ["owner"], keep: ["tenant.restore"] },
      { scope: "tenant", id: "o2", roles: ["owner"] },
    ]);
  });

  it("refuses a keep that is not a list of keys", () => {
    expect(() =>
      fromTable({
        table: "memberships",
        suspension: {
          scopes: {
            tenant: {
              table: "orgs",
              id: "id",
              disabledAt: "closed_at",
              // SAFETY: a malformed keep from an untyped config, which the source must refuse.
              keep: "tenant.restore" as unknown as readonly string[],
            },
          },
        },
      }),
    ).toThrow("a suspension keep is a list of permissions or permission keys");
  });
});
