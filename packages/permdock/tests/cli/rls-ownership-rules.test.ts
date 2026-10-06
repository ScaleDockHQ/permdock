import { describe, expect, it } from "vitest";

import type { RlsSqlContext } from "../../src/cli/rls-sql.ts";

import { ownershipRules, ownershipSql } from "../../src/cli/rls-ownership.ts";
import { scopeList } from "../../src/core/scopes.ts";
import {
  allow,
  definePermissions,
  definePolicy,
  defineRoles,
  resource,
  role,
} from "../../src/index.ts";
import { fromJunction, fromTable } from "../../src/supabase/sources.ts";

const Doc = {
  "~standard": {
    version: 1,
    vendor: "test",
    validate: (value: unknown) => ({ value }),
  },
} as const;

const permissions = definePermissions({
  doc: resource(Doc, {
    id: "id",
    actions: ["read"],
    relations: {
      org: { field: "org_id", memberOf: "org" },
      team: { field: "team_id", memberOf: "team" },
    },
  }),
});

const roles = defineRoles({
  operator: {},
  owner: { on: "org" },
  manager: { on: "team" },
  lead: { on: "team" },
  editor: {},
  auditor: {},
});

const policy = definePolicy(
  { permissions, roles },
  {
    scopes: { org: { key: "org_id" }, team: { key: "team_id", within: "org" } },
    // SAFETY: SQL generation never calls the subject mapper.
    subject: (user: unknown) => user as never,
    roles: [
      role(roles.operator, [allow(permissions.doc.read)], {
        assigns: ["owner", "editor", "auditor"],
        for: ["staff"],
      }),
      role(roles.owner, [allow(permissions.doc.read)], {
        on: "org",
        min: 1,
        max: 2,
        transferOnly: true,
        assigns: ["manager"],
      }),
      role(roles.manager, [allow(permissions.doc.read)], {
        on: "team",
        max: 3,
      }),
      role(roles.lead, [allow(permissions.doc.read)], {
        on: "team",
        assigns: ["owner", "manager"],
      }),
      role(roles.editor, [allow(permissions.doc.read)], {
        on: permissions.doc,
        assigns: ["owner"],
      }),
      role(roles.auditor, [allow(permissions.doc.read)]),
    ],
  },
);

const scopes = scopeList(policy.scopes);
const ownership = ownershipRules(policy, scopes);

function context(extra: Partial<RlsSqlContext>): RlsSqlContext {
  return {
    dialect: "supabase",
    scopes,
    tenantClaim: "tenant_id",
    gucPrefix: "app",
    tenantType: "text",
    ...(ownership === undefined ? {} : { ownership }),
    ...extra,
  };
}

const orgTable = {
  table: "org_members",
  user: "user_id",
  role: "role",
  expiresAt: "expires_at",
  via: "via",
  columns: { org: "org_id" },
};

describe("ownershipRules", () => {
  it("keeps assign pairs inside the scope chain and counts min, max and transferOnly", () => {
    expect(ownership).toEqual({
      kinds: { operator: ["staff"] },
      assigns: [
        { assigner: "operator", scope: "global", role: "owner", at: "org" },
        {
          assigner: "operator",
          scope: "global",
          role: "auditor",
          at: "global",
        },
        { assigner: "owner", scope: "org", role: "manager", at: "team" },
        { assigner: "lead", scope: "team", role: "manager", at: "team" },
      ],
      counted: [
        { role: "owner", scope: "org", min: 1, max: 2, transferOnly: true },
        { role: "manager", scope: "team", min: 0, max: 3, transferOnly: false },
      ],
    });
  });
});

describe("ownershipSql with a constant via", () => {
  it("counts holders of the constant kind without a via column", () => {
    const sql = ownershipSql(
      context({
        authorize: "database",
        memberships: {
          scopes: { org: { ...orgTable, via: { value: "staff" } } },
        },
      }),
    );
    expect(sql).not.toContain("coalesce('staff'");
    expect(sql).not.toContain('m."via"');
  });
});

describe("ownershipSql in database mode", () => {
  const sql = ownershipSql(
    context({
      authorize: "database",
      memberships: { scopes: { org: orgTable } },
    }),
  );

  it("writes min and max checks with expiry and kind filters on the mapped table", () => {
    expect(sql).toContain('create constraint trigger "permdock_holders_org"');
    expect(sql).toContain("keeps at least 1 owner");
    expect(sql).toContain("has at most 2 owner");
    expect(sql).toContain('(m."expires_at" is null or m."expires_at" > now())');
    expect(sql).toContain("-- team: no memberships table configured");
  });

  it("writes the transfer-only statement triggers for insert, update and delete", () => {
    for (const op of ["insert", "update", "delete"]) {
      expect(sql).toContain(
        `create trigger "permdock_transfer_only_org_${op}"`,
      );
    }
    expect(sql).toContain("referencing new table as permdock_new\n");
    expect(sql).toContain("referencing old table as permdock_old\n");
    expect(sql).toContain(
      "referencing old table as permdock_old new table as permdock_new",
    );
    expect(sql).toContain("array['owner']::text[]");
  });

  it("checks global and mapped-scope assigners in permdock_can_assign", () => {
    const canAssign = sql.slice(sql.indexOf("-- who may assign"));
    expect(canAssign).toContain(
      'p_scope_id is not null and exists (\n      select 1 from "permdock".user_roles ur',
    );
    expect(canAssign).toContain("in (values ('operator', 'owner'))");
    expect(canAssign).toContain(
      'p_scope_id is null and exists (\n      select 1 from "permdock".user_roles ur',
    );
    expect(canAssign).toContain("in (values ('operator', 'auditor'))");
    expect(canAssign).toContain("in (values ('owner', 'manager'))");
    expect(canAssign).not.toContain("('lead', 'manager')");
    expect(sql).not.toMatch(/service_role/iu);
  });
});

describe("ownershipSql over membership sources", () => {
  const memberSources = [
    fromTable({ table: "grants", columns: { via: "kind" } }),
    fromJunction({
      table: "team_leads",
      scope: "team",
      within: { org: "org_id" },
      roles: { sources: ["role", "backup_role"] },
    }),
  ];
  const sql = ownershipSql(context({ authorize: "jwt", memberSources }));

  it("collects each source table's changed rows into one transfer check", () => {
    const transfer = sql.slice(
      sql.indexOf("-- org: transfer-only roles (owner)"),
      sql.indexOf("-- team:"),
    );
    expect(transfer).toContain(
      `if tg_relid = '"public"."grants"'::regclass then`,
    );
    expect(transfer).not.toContain("team_leads");
    expect(transfer).toContain(
      "from permdock_new m where m.\"scope\"::text = 'org'",
    );
    expect(transfer).toContain(
      "from permdock_old m where m.\"scope\"::text = 'org'",
    );
    expect(transfer).toContain(
      "from jsonb_to_recordset(v_changes) x(id text, role text, delta bigint)",
    );
    expect(transfer).toContain("hint = 'transfer-only'");
    for (const op of ["insert", "update", "delete"]) {
      expect(transfer).toContain(
        `create trigger "permdock_transfer_only_org_${op}"\n  after ${op} on "public"."grants"`,
      );
    }
  });

  it("counts a nested scope over the sources that hold it", () => {
    const team = sql.slice(sql.indexOf("-- team:"));
    expect(team).toContain('on "public"."team_leads"');
    expect(team).toContain('on "public"."grants"');
    expect(team).toContain(`m."scope"::text = 'team'`);
    expect(team).toContain(`"mr".permdock_role as role`);
    expect(team).not.toContain("transfer-only roles");
  });
});

describe("ownershipSql in jwt mode", () => {
  it("reads roles and memberships from the claims", () => {
    const sql = ownershipSql(context({ authorize: "jwt" }));
    const canAssign = sql.slice(sql.indexOf("-- who may assign"));
    expect(canAssign).toContain(
      "(r.role, p_role) in (values ('operator', 'owner'))",
    );
    expect(canAssign).toContain("m ->> 'scope' = 'org'");
    expect(canAssign).toContain("m ->> 'scope' = 'team'");
    expect(sql).toContain("-- org: no memberships table configured");
  });

  it("answers false when no assigner can be checked", () => {
    const sql = ownershipSql(
      context({
        authorize: "database",
        ownership: {
          kinds: {},
          assigns: [
            { assigner: "lead", scope: "team", role: "manager", at: "team" },
          ],
          counted: [],
        },
      }),
    );
    expect(sql).toMatch(/and \(\n {4}false\n {2}\)/u);
  });
});

describe("permdock_can_assign for global roles without kinds", () => {
  const vocabulary = defineRoles({
    root: {},
    helpdesk: {},
    member: { on: "org" },
  });
  const plain = definePolicy(
    { permissions, roles: vocabulary },
    {
      scopes: { org: { key: "org_id" } },
      // SAFETY: SQL generation never calls the subject mapper.
      subject: (user: unknown) => user as never,
      roles: [
        role(vocabulary.root, [allow(permissions.doc.read)], {
          assigns: ["helpdesk", "member"],
        }),
        role(vocabulary.member, [allow(permissions.doc.read)], { on: "org" }),
      ],
    },
  );
  const plainScopes = scopeList(plain.scopes);
  const own = ownershipRules(plain, plainScopes);

  it("assigns a vocabulary-only global role at no instance in both modes", () => {
    expect(own?.assigns).toEqual([
      { assigner: "root", scope: "global", role: "helpdesk", at: "global" },
      { assigner: "root", scope: "global", role: "member", at: "org" },
    ]);
    for (const authorize of ["database", "jwt"] as const) {
      const sql = ownershipSql({
        dialect: "supabase",
        scopes: plainScopes,
        tenantClaim: "tenant_id",
        gucPrefix: "app",
        tenantType: "text",
        authorize,
        ...(own === undefined ? {} : { ownership: own }),
      });
      expect(sql).toContain(
        "(values ('root', 'member'))\n    )\n    or p_scope_id is null and exists",
      );
      expect(sql).toContain("(values ('root', 'helpdesk'))\n    )");
    }
  });
});
