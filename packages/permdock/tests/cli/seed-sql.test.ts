import { describe, expect, it } from "vitest";

import type { DoctorFiles } from "../../src/cli/shared/doctor-types.ts";
import type { PermDockConfig } from "../../src/cli/types.ts";

import { pd097 } from "../../src/cli/doctor/seed-data.ts";
import {
  FIXTURES_MARKER,
  defaultsSeedSql,
  fixturesSeedSql,
} from "../../src/cli/rls/emit/seed-sql.ts";
import { emitPgtap } from "../../src/cli/rls/verify-pgtap.ts";
import { defineSeeds } from "../../src/core/seeds.ts";
import {
  allow,
  definePermissions,
  definePolicy,
  resource,
  role,
} from "../../src/index.ts";
import { applySeeds, memorySources } from "../../src/testing/apply-seeds.ts";
import {
  memoryPostgrestSources,
  rolePersonas,
} from "../../src/testing/memory-postgrest.ts";

const permissions = definePermissions({
  doc: resource({
    actions: ["read"],
    relations: { org: { field: "orgId", memberOf: "tenant" } },
  }),
});

const policy = definePolicy(permissions, {
  scopes: { tenant: { key: "orgId" } },
  subject: () => null,
  roles: [role("admin", [allow(permissions.doc.read)], { on: "tenant" })],
});

const seeds = defineSeeds(policy, {
  defaults: {
    roles: [
      {
        key: "admin",
        scope: "tenant",
        system: true,
        grants: [permissions.doc.read],
      },
    ],
  },
  fixtures: {
    users: { alice: { id: "user-1", email: "alice@example.test" } },
    tenants: { acme: { id: "org-1" } },
    memberships: [{ user: "alice", tenant: "acme", roles: ["admin"] }],
    customRoles: [
      { tenant: "acme", key: "clerk", grants: [permissions.doc.read] },
    ],
    rows: { "public.docs": [{ id: "doc-1", org_id: "org-1" }] },
  },
});

describe("seed sql", () => {
  it("upserts default role rows and keeps fixtures out of that file", () => {
    const sql = defaultsSeedSql(seeds, "permdock");
    expect(sql).toContain("on conflict (role, grant_key, scope)");
    expect(sql).toContain("'admin'");
    expect(sql).toContain("'doc.read'");
    expect(sql).not.toContain(FIXTURES_MARKER);
  });

  it("writes fixture rows only in the seeds file", () => {
    const sql = fixturesSeedSql(seeds);
    expect(sql).toContain(FIXTURES_MARKER);
    expect(sql).toContain('insert into "public"."docs"');
    expect(sql).toContain("alice@example.test");
  });

  it("answers PostgREST reads and role personas from the fixtures", async () => {
    const sources = memoryPostgrestSources(seeds);
    expect(
      await sources.memberships.membershipsFor({ id: "user-1" }, {}),
    ).toStrictEqual([{ scope: "tenant", id: "org-1", roles: ["admin"] }]);
    expect(
      await sources.memberships.list?.({ scope: "tenant", id: "org-1" }),
    ).toStrictEqual([
      {
        principal: { id: "user-1" },
        membership: { scope: "tenant", id: "org-1", roles: ["admin"] },
      },
    ]);
    expect(await sources.customRoles.rolesFor("org-1")).toStrictEqual([
      { name: "clerk", tenant: "org-1", grants: [{ permission: "doc.read" }] },
    ]);
    const pgtap = emitPgtap({
      fixtures: [
        {
          subject: { id: "user-1", roles: ["admin"] },
          row: { id: "doc-1" },
          action: "doc.read",
          expected: "granted",
        },
      ],
      inProcess: [{ action: "doc.read", granted: true, kind: "portable" }],
      policy,
      config: { rls: { dialect: "supabase" } },
      customRoles: [],
      personas: "roles",
    });
    expect(pgtap).toContain("-- persona admin");
    expect(pgtap).toContain("permdock_persona");
    expect(rolePersonas(seeds)).toStrictEqual([
      {
        name: "admin",
        user: "user-1",
        tenant: "org-1",
        roles: ["admin"],
        permissions: ["doc.read"],
      },
    ]);
  });

  it("exposes the same rows in memory and through a query", async () => {
    expect(memorySources(seeds).roles[0]?.grants).toStrictEqual(["doc.read"]);
    const statements: string[] = [];
    await applySeeds(seeds, (text) => {
      statements.push(text);
      return Promise.resolve([]);
    });
    expect(statements[0]).toContain("role_permissions");
    expect(statements[1]).toContain('"public"."docs"');
  });
});

describe("PD097", () => {
  it("rejects fixture data in a migration and names the sql_paths line", async () => {
    const files = new Map<string, string>([
      [
        "/app/supabase/migrations/20260101000000_init.sql",
        `${FIXTURES_MARKER}\ninsert into docs values ('x');\n`,
      ],
      ["/app/supabase/seeds/permdock.sql", "-- permdock:fixtures v1\n"],
    ]);
    const reader: DoctorFiles = {
      exists: (path) => files.has(path) || path.endsWith("migrations"),
      read: (path) => files.get(path) ?? "",
      list: () => ["20260101000000_init.sql"],
      isDirectory: (path) => path.endsWith("migrations"),
    };
    const config: PermDockConfig = {};
    const findings = await pd097({ cwd: "/app", config, files: reader });
    expect(findings.some((finding) => finding.severity === "error")).toBe(true);
    expect(
      findings.find((finding) => finding.target === "supabase/config.toml")
        ?.message,
    ).toContain("sql_paths = ['./seeds/permdock.sql']");
  });
});
