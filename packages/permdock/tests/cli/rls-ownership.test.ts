import { describe, expect, it } from "vitest";

import type { RlsSqlContext } from "../../src/cli/rls-sql.ts";
import type { ScanResult } from "../../src/cli/types.ts";

import { buildCatalog } from "../../src/cli/catalog-doc.ts";
import { helpersSql } from "../../src/cli/rls-helpers.ts";
import { ownershipRules, ownershipSql } from "../../src/cli/rls-ownership.ts";
import { scopeList } from "../../src/core/scopes.ts";
import { fromJunction, fromTable } from "../../src/supabase/sources.ts";
import { permissions, policy } from "../fixtures/named-scopes.ts";

const scan: ScanResult = {
  roots: [],
  definitionFiles: {},
  usages: {},
  unknown: [],
  dynamic: [],
  roleNames: [],
  planNames: [],
  allowKeys: [],
  snapshots: [],
  unparsed: [],
};

const scopes = scopeList(policy.scopes);
const ownership = ownershipRules(policy, scopes);

function context(
  extra: Partial<RlsSqlContext>,
  { withOwnership = true }: { readonly withOwnership?: boolean } = {},
): RlsSqlContext {
  return {
    dialect: "guc",
    scopes,
    tenantClaim: "tenant_id",
    gucPrefix: "app",
    tenantType: "text",
    ...(!withOwnership || ownership === undefined ? {} : { ownership }),
    ...extra,
  };
}

const tables = {
  scopes: {
    organization: {
      table: "organization_users",
      user: "user_id",
      role: "role",
      via: "via",
      columns: { organization: "organization_id" },
    },
  },
};

describe("ownership in the catalog", () => {
  it("carries each role rule and audience", () => {
    const doc = buildCatalog(permissions, scan, "2026-09-29T00:00:00Z", policy);
    const byKey = new Map(doc.roles?.map((item) => [item.key, item]));
    expect(byKey.get("owner")).toEqual({
      key: "owner",
      on: "organization",
      assignable: false,
      min: 1,
      assigns: ["owner", "admin", "member", "viewer", "contact"],
      for: ["staff"],
      audience: "staff",
    });
    expect(byKey.get("contact")).toMatchObject({
      for: ["contact"],
      audience: "portal",
    });
    expect(byKey.get("platform-admin")).toEqual({
      key: "platform-admin",
      assignable: false,
      audience: "platform",
    });
  });
});

describe("ownership in generated RLS", () => {
  it("collects kinds, assign pairs within the scope chain, and counted roles", () => {
    expect(ownership?.kinds).toMatchObject({
      owner: ["staff"],
      contact: ["contact"],
    });
    expect(ownership?.assigns).toContainEqual({
      assigner: "admin",
      scope: "organization",
      role: "contact",
      at: "customer",
    });
    expect(ownership?.counted).toEqual([
      { role: "owner", scope: "organization", min: 1, transferOnly: false },
    ]);
  });

  it("filters helper rows by membership kind in both modes", () => {
    const database = helpersSql(
      context({ authorize: "database", memberships: tables }),
      [],
      { userRoles: false },
    );
    expect(database).toContain(
      `when 'owner' then coalesce(m."via"::text, '') = any(array['staff']::text[])`,
    );
    const jwt = helpersSql(context({ authorize: "jwt" }), [], {
      userRoles: false,
    });
    expect(jwt).toContain(`coalesce(m ->> 'via', '')`);
  });

  it("holds a role with for and no kind column for nothing", () => {
    const { via: _, ...bare } = tables.scopes.organization;
    const sql = helpersSql(
      context({
        authorize: "database",
        memberships: { scopes: { organization: bare } },
      }),
      [],
      { userRoles: false },
    );
    expect(sql).toContain(
      `and not (m."role"::text = any(array['admin', 'contact', 'member', 'owner', 'viewer']::text[]))`,
    );
    expect(sql).not.toContain("coalesce(null");
  });

  it("emits the holder trigger only where a table is mapped", () => {
    const mapped = ownershipSql(
      context({ authorize: "database", memberships: tables }),
    );
    expect(mapped).toContain(
      'create constraint trigger "permdock_holders_organization"',
    );
    expect(mapped).toContain("deferrable initially deferred");
    expect(mapped).toContain(
      "permdock_can_assign(p_role text, p_scope_id text)",
    );
    expect(mapped).not.toMatch(/service_role/iu);
    const unmapped = ownershipSql(context({ authorize: "jwt" }));
    expect(unmapped).toContain("checked only by decideRoleChange");
    expect(unmapped).toContain(`m ->> 'scope' = 'organization'`);
  });

  it("puts the holder triggers on every table-backed source of the scope", () => {
    const sources = [
      fromTable({
        table: "access.grants",
        columns: {
          user: {
            through: "access.principals",
            on: { principal_id: "id" },
            column: "user_id",
          },
          role: {
            through: "access.roles",
            on: { role_id: "id" },
            column: "key",
          },
          via: "kind",
        },
      }),
      fromJunction({
        table: "organization_owners",
        scope: "organization",
        roles: ["owner"],
        via: "staff",
        expiresAt: "until",
      }),
      fromJunction({
        table: "customer_contacts",
        scope: "customer",
        roles: ["contact"],
      }),
    ];
    const sql = ownershipSql(
      context({ authorize: "database", sources, memberSources: sources }),
    );
    for (const table of [
      '"access"."grants"',
      '"public"."organization_owners"',
    ]) {
      expect(sql).toContain(
        `create constraint trigger "permdock_holders_organization"\n  after insert or update or delete on ${table}`,
      );
    }
    expect(sql).not.toContain('on "public"."customer_contacts"');
    expect(sql).toContain('v_key_0 "access"."grants"."scope_id"%type;');
    expect(sql).toContain(
      `case when old."scope"::text = 'organization' then old."scope_id"::text end`,
    );
    expect(sql).toContain(
      `join "access"."principals" mu on mu."id" = m."principal_id"`,
    );
    expect(sql).toContain(`unnest(array['owner']::text[]) mf(role)`);
    expect(sql).toContain(`(m."until" is null or m."until" > now()) as live`);
    expect(sql).toContain(
      `and coalesce(h.via, '') = any(array['staff']::text[])`,
    );
    expect(sql).not.toContain("checked only by decideRoleChange");
  });

  it("falls back to decideRoleChange when a source has no table", () => {
    const [table] = [fromTable({ table: "grants" })];
    const { holders: _, ...sql } = table.sql;
    const source = { ...table, sql };
    expect(
      ownershipSql(context({ authorize: "jwt", memberSources: [source] })),
    ).toContain(
      "-- organization: a membership source is not a table, so min, max and transferOnly are checked only by decideRoleChange",
    );
  });

  it("emits nothing for a policy without rules", () => {
    expect(ownershipSql(context({}, { withOwnership: false }))).toBe("");
  });
});
