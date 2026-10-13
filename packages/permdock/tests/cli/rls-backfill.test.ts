import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { RlsSqlContext } from "../../src/cli/sql/context.ts";
import type {
  PermDockConfig,
  RlsCustomRolesFrom,
} from "../../src/cli/types.ts";

import { backfillSql, legacyKeySql } from "../../src/cli/rls/backfill.ts";
import { runRlsGenerate } from "../../src/cli/rls/generate.ts";
import { mapKey } from "../../src/cli/rls/migrate.ts";
import { scopeList } from "../../src/core/scopes.ts";
import { policy } from "../fixtures/named-scopes.ts";

const roles = {
  table: "public.roles",
  key: "key",
  tenant: "organization_id",
  skip: "builtin",
};

const from: RlsCustomRolesFrom = {
  permissions: {
    table: "role_permissions",
    role: { through: "roles", on: { role_id: "id" }, column: "key" },
    permission: {
      through: "permissions",
      on: { permission_id: "id" },
      column: "key",
    },
    effect: "effect",
  },
  includes: {
    table: "role_includes",
    role: { through: "roles", on: { role_id: "id" }, column: "key" },
    include: "included_role",
  },
};

const ctx: RlsSqlContext = {
  dialect: "supabase",
  tenantClaim: "tenant_id",
  scopes: scopeList(policy.scopes),
  gucPrefix: "app",
  tenantType: "uuid",
  authorize: "database",
  customRoles: {
    declared: ["admin", "member", "owner", "viewer"],
    assignable: ["admin", "member", "viewer"],
    permissions: ["asset.read"],
    renamed: { "asset.view": "asset.read" },
    table: roles,
  },
};

describe("legacyKeySql", () => {
  it("maps keys first, then renamed, then the longest prefix, as mapKey does", () => {
    const migrate = {
      helpers: {},
      keys: { "org.assets.see": "asset.read" },
      prefixes: { "org.": "", "org.assets.": "asset." },
    };
    const renamed = { "asset.view": "asset.read" };
    const sql = legacyKeySql("k", migrate, renamed);
    expect(sql).toBe(
      "(case (case k when 'asset.view' then 'asset.read' when 'org.assets.see' then 'asset.read' else (case when left(k, 11) = 'org.assets.' then 'asset.' || substr(k, 12) when left(k, 4) = 'org.' then '' || substr(k, 5) else k end) end) when 'asset.view' then 'asset.read' else (case k when 'asset.view' then 'asset.read' when 'org.assets.see' then 'asset.read' else (case when left(k, 11) = 'org.assets.' then 'asset.' || substr(k, 12) when left(k, 4) = 'org.' then '' || substr(k, 5) else k end) end) end)",
    );
    expect(mapKey(migrate, "org.assets.list", renamed)).toBe("asset.list");
    expect(mapKey(migrate, "org.assets.see", renamed)).toBe("asset.read");
  });

  it("is the key itself without a mapping", () => {
    expect(legacyKeySql("k", undefined, {})).toBe("k");
  });
});

describe("backfillSql", () => {
  it("copies roles without rows through the trusted replace function", () => {
    const sql = backfillSql(ctx, from, undefined);
    expect(sql.startsWith("-- permdock:backfill v1 schema=permdock\n")).toBe(
      true,
    );
    expect(sql).toContain(
      `select r."organization_id"::uuid as tenant_id, case when r."organization_id"::uuid is null then 'global' else 'organization' end as scope, null::text as scope_id, r."key"::text as role, r."id" as permissions_ref, r."id" as includes_ref
    from "public"."roles" r
    where not coalesce(r."builtin", false) and not (r."key"::text = any(array['admin', 'member', 'owner', 'viewer']::text[]))`,
    );
    expect(sql).toContain(
      `select (select xk."key"::text from "public"."permissions" xk where xk."id" = x."permission_id") as legacy, coalesce(lower(x."effect"::text), 'allow') as effect, null::text as level
      from "public"."role_permissions" x
      where x."role_id" = v.permissions_ref`,
    );
    expect(sql).toContain("then 'outside the ceiling of ' || v.scope");
    expect(sql).toContain("then 'not a declared permission'");
    expect(sql).toContain(
      `perform "permdock".permdock_trusted_replace_custom_role_grants(v.tenant_id, v.scope, v.scope_id, v.role, v_allow, v_deny, v_include);`,
    );
    expect(sql).toContain("v_present := v_present + 1;\n      continue;");
    expect(sql).toContain(
      `from "public"."role_includes" x
      where x."role_id" = v.includes_ref`,
    );
    expect(sql).toContain("raise warning 'permdock backfill: dropped %");
  });

  it("leaves includes out without a mapping and maps no level without levels", () => {
    const { effect: _effect, ...permissions } = from.permissions;
    const sql = backfillSql(ctx, { permissions }, undefined);
    expect(sql).toContain("    v_include := null;");
    expect(sql).not.toContain("includes_ref");
    expect(sql).toContain("select (select xk.");
    expect(sql).toContain(", 'allow' as effect,");
  });

  it("refuses jwt mode, a missing roles table, a foreign reference and a level without levels", () => {
    expect(() =>
      backfillSql({ ...ctx, authorize: "jwt" }, from, undefined),
    ).toThrow(/customRoleClaim/u);
    const { table: _table, ...unmapped } = ctx.customRoles ?? {
      declared: [],
      assignable: [],
    };
    expect(() =>
      backfillSql({ ...ctx, customRoles: unmapped }, from, undefined),
    ).toThrow(/rls.customRoleWrites.roles/u);
    expect(() =>
      backfillSql(
        ctx,
        {
          permissions: {
            ...from.permissions,
            role: { through: "teams", on: { team_id: "id" }, column: "key" },
          },
        },
        undefined,
      ),
    ).toThrow(/must be rls.customRoleWrites.roles.table/u);
    expect(() =>
      backfillSql(
        ctx,
        {
          permissions: {
            ...from.permissions,
            role: { through: "roles", on: { role_id: "id" }, column: "name" },
          },
        },
        undefined,
      ),
    ).toThrow(/must be rls.customRoleWrites.roles.key/u);
    expect(() =>
      backfillSql(
        ctx,
        { permissions: { ...from.permissions, level: "level" } },
        undefined,
      ),
    ).toThrow(/no resource declares levels/u);
  });

  it("checks a stored level against the ceiling with levels", () => {
    const sql = backfillSql(
      {
        ...ctx,
        customRoles: {
          ...(ctx.customRoles ?? { declared: [], assignable: [] }),
          levels: true,
        },
      },
      { permissions: { ...from.permissions, level: "level" } },
      undefined,
    );
    expect(sql).toContain(`nullif(x."level"::text, '') as level`);
    expect(sql).toContain("then 'level ' || m.level || ' is not declared'");
    expect(sql).toContain(
      "array_agg(distinct j.key || coalesce('@' || j.level, ''))",
    );
  });
});

describe("backfillSql with platform-only roles in another schema", () => {
  const platform: RlsSqlContext = {
    ...ctx,
    customRoles: {
      declared: ["admin"],
      assignable: ["admin"],
      renamed: { "a.old": "asset.read", "b.old": "asset.read" },
      table: { table: "app.roles", key: "key", scope: "scope", id: "scope_id" },
    },
  };
  const appFrom: RlsCustomRolesFrom = {
    permissions: {
      table: "app.role_permissions",
      role: { through: "roles", on: { role_id: "id" }, column: "key" },
      permission: "permission",
    },
  };

  it("reads the scope and instance columns and resolves an unqualified through in the table's schema", () => {
    const sql = backfillSql(platform, appFrom, {
      helpers: {},
      prefixes: { "ab.": "", "aa.": "x." },
    });
    expect(sql).toContain(
      `select null::uuid as tenant_id, case when null::uuid is null then 'global' else r."scope"::text end as scope, r."scope_id"::text as scope_id`,
    );
    expect(sql).toContain('from "app"."roles" r\n    where not false');
    expect(sql).toContain("not (m.key = any(array['a.old', 'b.old']::text[]))");
    expect(sql).toContain(
      "when left(n.legacy, 3) = 'aa.' then 'x.' || substr(n.legacy, 4) when left(n.legacy, 3) = 'ab.'",
    );
  });

  it("refuses custom roles off and a reference that maps no single column", () => {
    const { customRoles: _customRoles, ...off } = ctx;
    expect(() => backfillSql(off, appFrom, undefined)).toThrow(
      /needs custom roles on/u,
    );
    expect(() =>
      backfillSql(
        platform,
        {
          permissions: {
            ...appFrom.permissions,
            role: {
              through: "app.roles",
              on: { role_id: "id", org_id: "organization_id" },
              column: "key",
            },
          },
        },
        undefined,
      ),
    ).toThrow(/must map exactly one column/u);
  });
});

const TMP = path.join(import.meta.dirname, "../../tmp");
mkdirSync(TMP, { recursive: true });
const cwd = mkdtempSync(path.join(TMP, "rls-backfill-"));
writeFileSync(
  path.join(cwd, "policy.ts"),
  `import { allow, definePermissions, definePolicy, resource, role } from 'permdock';

const permissions = definePermissions({
  job: resource({ id: 'id', actions: ['read'], relations: { org: { field: 'orgId', memberOf: 'tenant' } } }),
});

export const policy = definePolicy(permissions, {
  scopes: { tenant: { key: 'orgId' } },
  roles: [role('member', [allow(permissions.job.read)], { on: 'tenant', assignable: true })],
  subject: () => null,
});
`,
);

afterAll(() => {
  rmSync(cwd, { recursive: true, force: true });
});

const io = {
  stdout: () => undefined,
  stderr: () => undefined,
  now: () => new Date("2026-10-11T08:00:00Z"),
};

function generate(
  rls: NonNullable<PermDockConfig["rls"]>,
  options: { readonly backfillOut?: string; readonly check?: boolean } = {},
) {
  return runRlsGenerate({
    cwd,
    config: {
      policy: "./policy.ts",
      rls: {
        authorize: "database",
        memberships: {
          tenant: {
            table: "organization_members",
            tenant: "organization_id",
            user: "user_id",
            role: "role",
          },
        },
        customRoleWrites: { roles },
        ...rls,
      },
    },
    target: "sql",
    dialect: "supabase",
    rbac: false,
    check: options.check ?? false,
    skipClosures: false,
    inlineFunctions: false,
    out: "supabase/schemas/permdock.sql",
    io,
    ...(options.backfillOut === undefined
      ? {}
      : { backfillOut: options.backfillOut }),
  });
}

describe("rls generate --backfill-out", () => {
  it("needs rls.customRoles.from", async () => {
    const outcome = await generate({ customRoles: true }, { backfillOut: "-" });
    expect(outcome.code).toBe(2);
    expect(outcome.output).toBe(
      "rls generate --backfill-out needs rls.customRoles.from in permdock.config.ts",
    );
  });

  it("fails on a mapping it cannot read", async () => {
    const outcome = await generate({
      customRoles: { from },
      customRoleWrites: {},
    });
    expect(outcome.code).toBe(2);
    expect(outcome.output).toContain("rls.customRoleWrites.roles");
  });

  it("turns custom roles on with an object", async () => {
    const outcome = await generate({ customRoles: { from } });
    expect(outcome.code).toBe(0);
    expect(
      readFileSync(path.join(cwd, "supabase/schemas/permdock.sql"), "utf8"),
    ).toContain("custom_role_permissions");
  });

  it("writes a versioned migration into a directory once, and --check names it", async () => {
    const dir = path.join(cwd, "supabase/migrations");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "20261001000000_init.sql"), "select 1;\n");
    const first = await generate(
      { customRoles: { from } },
      { backfillOut: "supabase/migrations/" },
    );
    expect(first.code).toBe(0);
    const written = path.join(dir, "20261001000001_permdock_backfill.sql");
    expect(existsSync(written)).toBe(true);
    expect(readFileSync(written, "utf8")).toMatch(
      /^-- permdock:backfill v1 schema=permdock\n/u,
    );
    const again = await generate(
      { customRoles: { from } },
      { backfillOut: "supabase/migrations/" },
    );
    expect(again.output).not.toContain("permdock_backfill");
    expect(readdirSync(dir)).toHaveLength(2);
    const check = await generate(
      { customRoles: { from } },
      { backfillOut: "supabase/migrations/", check: true },
    );
    expect(check.code).toBe(0);
    writeFileSync(written, "-- permdock:backfill v1 schema=permdock\nstale\n");
    const stale = await generate(
      { customRoles: { from } },
      { backfillOut: "supabase/migrations/", check: true },
    );
    expect(stale.code).toBe(1);
    expect(stale.output).toContain(
      "backfill: missing supabase/migrations/20261001000002_permdock_backfill.sql",
    );
  });

  it("gives seeds and backfill in one directory different versions", async () => {
    const dir = path.join(cwd, "db/migrations");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "20261001000000_init.sql"), "select 1;\n");
    const run = (check = false) =>
      runRlsGenerate({
        cwd,
        config: {
          policy: "./policy.ts",
          rls: {
            authorize: "database",
            memberships: {
              tenant: {
                table: "organization_members",
                tenant: "organization_id",
                user: "user_id",
                role: "role",
              },
            },
            customRoleWrites: { roles },
            customRoles: { from },
          },
        },
        target: "sql",
        dialect: "supabase",
        rbac: false,
        check,
        skipClosures: false,
        inlineFunctions: false,
        split: "helpers,seeds",
        out: "db/schemas/permdock_{part}.sql",
        seedsOut: "db/migrations/",
        backfillOut: "db/migrations/",
        io,
      });
    const missing = await run(true);
    expect(missing.code).toBe(1);
    expect(missing.output).toContain(
      "seeds: missing db/migrations/20261001000001_permdock_seeds.sql",
    );
    expect(missing.output).toContain(
      "backfill: missing db/migrations/20261001000002_permdock_backfill.sql",
    );
    expect((await run()).code).toBe(0);
    expect(readdirSync(dir).toSorted()).toEqual([
      "20261001000000_init.sql",
      "20261001000001_permdock_seeds.sql",
      "20261001000002_permdock_backfill.sql",
    ]);
    expect((await run()).code).toBe(0);
    expect(readdirSync(dir)).toHaveLength(3);
    expect((await run(true)).code).toBe(0);
  });
});
