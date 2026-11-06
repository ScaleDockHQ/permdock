import { describe, expect, it } from "vitest";

import type { DoctorFiles } from "../../src/cli/shared/doctor-types.ts";
import type { PermDockConfig } from "../../src/cli/types.ts";

import { pd097 } from "../../src/cli/doctor/seed-data.ts";
import {
  FIXTURES_MARKER,
  defaultsSeedSql,
  fixturesSeedSql,
} from "../../src/cli/rls/emit/seed-sql.ts";
import { defineSeeds } from "../../src/core/seeds.ts";
import {
  allow,
  definePermissions,
  definePolicy,
  resource,
  role,
} from "../../src/index.ts";
import { applySeeds, memorySources } from "../../src/testing/apply-seeds.ts";

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
