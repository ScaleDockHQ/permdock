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
  manager = false,
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
    role('owner', [allow(permissions.job.update)], { on: 'tenant', assignable: false }),${
      manager
        ? "\n    role('manager', [allow(permissions.job.update, { where: { ownerId: principal.id } })], { on: 'tenant' }),"
        : ""
    }
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

  it("emits the custom-role write functions in database mode only", async () => {
    const leveled = await generate(appWith(true, "database", true));
    for (const name of [
      "permdock_custom_role_beyond",
      "permdock_custom_role_guard",
      "permdock_replace_custom_role_grants",
      "permdock_rename_custom_role_grants",
      "permdock_delete_custom_role_grants",
    ]) {
      expect(leveled).toContain(
        `create or replace function "permdock".${name}(`,
      );
    }
    expect(leveled).toContain(
      'grant execute on function "permdock".permdock_replace_custom_role_grants(text, text, text, text, text[], text[], text[]) to authenticated;',
    );
    expect(leveled).toContain(
      'revoke execute on function "permdock".permdock_custom_role_beyond(text, text, text, text[], text[], text[]) from public, anon, authenticated;',
    );
    expect(leveled).toContain(
      "reach (grant_key, level) as (values ('job.read', 'all'), ('job.read', 'own')",
    );
    expect(leveled).toContain("when 'task.read' then 'job.read'");
    expect(leveled).toContain("hint = 'unknown-level'");
    expect(leveled).not.toMatch(/service_role/iu);
    const plain = await generate(appWith(false, "database"));
    expect(plain).toContain("permdock_replace_custom_role_grants");
    expect(plain).not.toContain("reach (grant_key, level)");
    expect(plain).not.toContain("unknown-level");
    expect(plain).toContain("if false then");
    const jwt = await generate(appWith(true, "jwt"));
    expect(jwt).not.toContain("permdock_replace_custom_role_grants");
  });

  it("reaches only the levels whose condition a conditioned grant matches", async () => {
    const sql = await generate(appWith(true, "database", false, true));
    const reach = /reach \(grant_key, level\) as \(values ([^\n]+)\)/u.exec(
      sql,
    )?.[1];
    expect(reach).toContain(
      "('job.update#3', 'own'), ('job.update#3@own', 'own')",
    );
    expect(reach).not.toContain("('job.update#3', 'all')");
    expect(reach).not.toContain("'job.update#3@all'");
    expect(reach).toContain("('job.update#1', 'all'), ('job.update#1', 'own')");
  });

  it("passes levels to the rbac scaffold", async () => {
    const sql = await generate(appWith(true, "database"), ["--rbac-scaffold"]);
    expect(sql).toContain("coalesce('@' || c.level, '')");
    expect(sql).toContain('create or replace function "permdock"."authorize"(');
  });

  it("checks rls.customRoleWrites.requires before the hand-out check", async () => {
    const requiring = (requires: string): string => {
      const dir = appWith(false, "database");
      const configPath = join(dir, "permdock.config.ts");
      writeFileSync(
        configPath,
        readFileSync(configPath, "utf8").replace(
          "customRoles: true,",
          `customRoles: true,\n    customRoleWrites: { requires: ${requires} },`,
        ),
      );
      return dir;
    };
    const sql = await generate(requiring("['job.update']"));
    const guard = sql.slice(
      sql.indexOf(
        'create or replace function "permdock".permdock_custom_role_guard(',
      ),
    );
    const check = guard.indexOf("hint = 'manage-roles'");
    expect(check).toBeGreaterThan(guard.indexOf("hint = 'not-member'"));
    expect(check).toBeLessThan(guard.indexOf("hint = 'not-assignable-by'"));
    expect(guard).toContain("rp.permission = any(array['job.update']::text[])");
    expect(await generate(appWith(false, "database"))).not.toContain(
      "manage-roles",
    );
    for (const [requires, message] of [
      ["'manageRoles'", "no permission declares meta.manageRoles"],
      ["['job.nope']", "undeclared permissions: job.nope"],
      ["[]", "names no permission"],
    ] as const) {
      const result = await run(
        ["rls", "generate", "--target", "sql", "--out", "rls.sql"],
        { cwd: requiring(requires) },
      );
      expect(result.code).toBe(2);
      expect(result.stdout).toContain(message);
    }
  });
});
