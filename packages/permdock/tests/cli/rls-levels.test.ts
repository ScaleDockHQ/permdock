import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { run } from "../../src/cli/run.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "./fixtures/mini-app");
const TMP = join(HERE, "../../tmp");

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function appWith(
  levels: boolean,
  authorize: "database" | "jwt",
  renamed = false,
): string {
  mkdirSync(TMP, { recursive: true });
  const dir = mkdtempSync(join(TMP, "rls-levels-"));
  temps.push(dir);
  cpSync(FIXTURE, dir, { recursive: true });
  writeFileSync(
    join(dir, "src/levels.ts"),
    `import { allow, definePermissions, definePolicy, deny, principal, resource, role } from 'permdock';

export const permissions = definePermissions({
  job: resource({
    id: 'id',
    actions: ['read', 'update'],
    relations: { org: { field: 'orgId', memberOf: 'tenant' } },
    ${levels ? "levels: { own: { ownerId: principal.id }, all: {} }," : ""}
  }),
}${renamed ? ", { renamed: { 'task.read': 'job.read' } }" : ""});

export const policy = definePolicy(permissions, {
  roles: [
    role('admin', [allow([permissions.job.read, permissions.job.update]), deny(permissions.job.update, { where: { locked: true } })], { on: 'tenant' }),
    role('owner', [allow(permissions.job.update)], { on: 'tenant', assignable: false }),
  ],
  scopes: { tenant: { key: 'orgId' } },
  subject: () => null,
});
`,
  );
  writeFileSync(
    join(dir, "permdock.config.ts"),
    `export default {
  permissions: './src/levels.ts',
  policy: './src/levels.ts',
  rls: {
    dialect: 'supabase',
    tenantType: 'text',
    authorize: '${authorize}',
    customRoles: true,
    ${
      authorize === "database"
        ? "memberships: { tenant: { table: 'organization_members', tenant: 'organization_id', user: 'user_id', role: 'role' } },"
        : ""
    }
  },
};
`,
  );
  return dir;
}

async function generate(
  cwd: string,
  extra: readonly string[] = [],
): Promise<string> {
  const result = await run(
    ["rls", "generate", "--target", "sql", "--out", "rls.sql", ...extra],
    { cwd },
  );
  if (result.code !== 0) {
    throw new Error(result.stdout);
  }
  return readFileSync(join(cwd, "rls.sql"), "utf8");
}

describe("rls generate with resource levels", () => {
  it("adds a level column and a leveled grant key per level (database)", async () => {
    const sql = await generate(appWith(true, "database"));
    expect(sql).toContain(
      "add column if not exists level text check (level ~ '^[a-z][a-z0-9_]*$')",
    );
    expect(sql).toContain("'job.read@own'");
    expect(sql).toMatch(/'job\.update#\d@all'/u);
    expect(sql).toContain("permission || coalesce('@' || c.level, '')");
    expect(sql).not.toMatch(/service_role/iu);
  });

  it("reads key@level claim entries (jwt)", async () => {
    const sql = await generate(appWith(true, "jwt"));
    expect(sql).toContain("'job.read@own'");
    expect(sql).not.toContain("custom_role_permissions");
    expect(sql).toContain("split_part(");
  });

  it("emits nothing level-shaped without declared levels", async () => {
    for (const authorize of ["database", "jwt"] as const) {
      const sql = await generate(appWith(false, authorize));
      expect(sql).not.toContain("@own");
      expect(sql).not.toContain("c.level");
      expect(sql).not.toContain("add column if not exists level");
      expect(sql).not.toContain("allowed_levels");
    }
  });

  it("maps a stored former key before splitting off its level", async () => {
    const sql = await generate(appWith(true, "database", true));
    expect(sql).toContain("('task.read', 'job.read')");
    expect(sql).toContain("allowed_levels");
  });

  it("passes levels to the rbac scaffold", async () => {
    const sql = await generate(appWith(true, "database"), ["--rbac-scaffold"]);
    expect(sql).toContain("coalesce('@' || c.level, '')");
    expect(sql).toContain('create or replace function "permdock"."authorize"(');
  });
});
