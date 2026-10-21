import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { run } from "../../src/cli/core/run.ts";
import { miniAppCopy, removeProjects } from "./doctor-kit.ts";

afterEach(removeProjects);

describe("permdock rls", () => {
  it("prints command help when no subcommand is given", async () => {
    const result = await run(["rls"]);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("generate");
    expect(result.stderr).toContain("import");
    expect(result.stderr).toContain("verify");
  });

  it("lists rls in --help", async () => {
    const result = await run(["--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("rls");
  });

  it("generates for rls.dialect from the config, and --dialect overrides it", async () => {
    const generate = async (
      dialect: string,
      extra: readonly string[],
    ): Promise<{
      readonly code: number;
      readonly out: string;
      sql: string;
    }> => {
      const cwd = miniAppCopy();
      writeFileSync(
        join(cwd, "permdock.config.ts"),
        `export default {
  permissions: './src/permissions.ts',
  policy: './src/policy.ts',
  rls: { dialect: '${dialect}' },
};
`,
      );
      const result = await run(
        ["rls", "generate", "--target", "sql", "--out", "rls.sql", ...extra],
        { cwd },
      );
      let sql = "";
      try {
        sql = readFileSync(join(cwd, "rls.sql"), "utf8");
      } catch {
        sql = "";
      }
      return {
        code: result.code,
        out: `${result.stdout}${result.stderr}`,
        sql,
      };
    };
    const guc = await generate("guc", []);
    expect(guc.code).toBe(0);
    expect(guc.sql).toContain(`current_setting('app.user_id', true)`);
    expect(guc.sql).not.toContain("auth.uid()");
    const neon = await generate("neon", []);
    expect(neon.sql).toContain("(select auth.user_id())");
    expect(neon.sql).not.toContain("auth.uid()");
    const override = await generate("guc", ["--dialect", "supabase"]);
    expect(override.sql).toContain('(select "permdock".permdock_user_id())');
    expect(override.sql).not.toContain("current_setting('app.");
    const invalid = await generate("mysql", []);
    expect(invalid.code).toBe(2);
    expect(invalid.out).toContain("--dialect (or rls.dialect) must be");
  });

  it("adds FORCE ROW LEVEL SECURITY only with --force", async () => {
    const cwd = miniAppCopy();
    const generate = (out: string, target: string, extra: readonly string[]) =>
      run(
        [
          "rls",
          "generate",
          "--target",
          target,
          "--dialect",
          "supabase",
          "--out",
          out,
          ...extra,
        ],
        { cwd },
      );
    await generate("plain.sql", "sql", []);
    expect(readFileSync(join(cwd, "plain.sql"), "utf8")).not.toContain(
      "force row level security",
    );
    await generate("forced.sql", "sql", ["--force-rls"]);
    expect(readFileSync(join(cwd, "forced.sql"), "utf8")).toMatch(
      /enable row level security;\nalter table "[^"]+"\."[^"]+" force row level security;/u,
    );
    const drizzle = await generate("policies.ts", "drizzle", ["--force-rls"]);
    expect(drizzle.stdout).toContain("policies.migration.sql");
    expect(readFileSync(join(cwd, "policies.migration.sql"), "utf8")).toMatch(
      /enable row level security;\nalter table "[^"]+"\."[^"]+" force row level security;/u,
    );
  });

  it("generates SQL without service_role and compiles principal.id", async () => {
    const cwd = miniAppCopy();
    const result = await run(
      [
        "rls",
        "generate",
        "--target",
        "sql",
        "--dialect",
        "supabase",
        "--out",
        "rls.sql",
      ],
      { cwd },
    );
    expect(result.code).toBe(0);
    const sql = readFileSync(join(cwd, "rls.sql"), "utf8");
    expect(sql).not.toMatch(/service_role/iu);
    expect(sql).toContain("enable row level security");
    expect(sql).toContain("revoke all");
    expect(sql).toContain('(select "permdock".permdock_user_id())');
    expect(sql).toContain("for update");
    expect(sql).toContain("with check");
    expect(sql).toContain("for select");
    expect(result.stdout).toMatch(/approval:human|skipped approval/iu);
  });

  it("collapses policies by default and keeps the per-role shape behind a flag", async () => {
    const cwd = miniAppCopy();
    const base = ["rls", "generate", "--target", "sql"];
    await run([...base, "--out", "collapsed.sql"], { cwd });
    const collapsed = readFileSync(join(cwd, "collapsed.sql"), "utf8");
    expect(collapsed.match(/create policy "post_select"/gu)).toHaveLength(1);
    expect(collapsed).not.toContain("member_post_read");
    await run([...base, "--policy-per-role", "--out", "per-role.sql"], { cwd });
    const perRole = readFileSync(join(cwd, "per-role.sql"), "utf8");
    expect(perRole).toContain('create policy "member_post_read"');
    expect(perRole).toContain('create policy "member_post_list"');
    await run([...base, "--policy-name", "pd_{table}_{op}", "--out", "n.sql"], {
      cwd,
    });
    expect(readFileSync(join(cwd, "n.sql"), "utf8")).toContain(
      'create policy "pd_post_update"',
    );
  });

  it("generate --check reports drift then up to date", async () => {
    const cwd = miniAppCopy();
    const missing = await run(
      ["rls", "generate", "--target", "sql", "--out", "rls.sql", "--check"],
      { cwd },
    );
    expect(missing.code).toBe(1);
    await run(["rls", "generate", "--target", "sql", "--out", "rls.sql"], {
      cwd,
    });
    const fresh = await run(
      ["rls", "generate", "--target", "sql", "--out", "rls.sql", "--check"],
      { cwd },
    );
    expect(fresh.code).toBe(0);
    expect(fresh.stdout).toContain("up to date");
  });

  it("compiles memberOf through a memberships table mapping", async () => {
    const cwd = miniAppCopy();
    writeFileSync(
      join(cwd, "src/tenant-policy.ts"),
      `import { allow, definePolicy, role } from 'permdock';
import { permissions } from './permissions.ts';

const admin = role('admin', [allow(permissions.post.read)], { on: 'tenant' });

export const policy = definePolicy(permissions, {
  roles: [admin],
  scopes: { tenant: { key: 'orgId' } },
  subject: () => null,
});
`,
    );
    writeFileSync(
      join(cwd, "permdock.config.ts"),
      `export default {
  permissions: './src/permissions.ts',
  policy: './src/tenant-policy.ts',
};
`,
    );
    const result = await run(
      [
        "rls",
        "generate",
        "--target",
        "sql",
        "--dialect",
        "supabase",
        "--memberships",
        "organization_members:organization_id,user_id,role",
        "--out",
        "rls.sql",
      ],
      { cwd },
    );
    expect(result.code).toBe(0);
    const sql = readFileSync(join(cwd, "rls.sql"), "utf8");
    expect(sql).toContain('from "public"."organization_members" m');
    expect(sql).toContain(
      `"orgId" in (select "permdock".permitted_tenant_ids('post.read'))`,
    );
    expect(sql).toContain("security definer");
    expect(sql).toContain(
      'grant execute on function "permdock".permitted_tenant_ids(text) to authenticated;',
    );
    expect(sql).not.toMatch(/service_role/iu);
  });

  it("resolves custom roles only with --custom-roles, bounded by the ceiling view", async () => {
    const cwd = miniAppCopy();
    writeFileSync(
      join(cwd, "src/tenant-policy.ts"),
      `import { allow, definePolicy, role } from 'permdock';
import { permissions } from './permissions.ts';

export const policy = definePolicy(permissions, {
  roles: [
    role('admin', [allow(permissions.post.read)], { on: 'tenant' }),
    role('owner', [allow(permissions.post.delete)], { on: 'tenant', assignable: false }),
  ],
  scopes: { tenant: { key: 'orgId' } },
  subject: () => null,
});
`,
    );
    writeFileSync(
      join(cwd, "permdock.config.ts"),
      `export default {
  permissions: './src/permissions.ts',
  policy: './src/tenant-policy.ts',
};
`,
    );
    const generate = async (extra: readonly string[]): Promise<string> => {
      const result = await run(
        [
          "rls",
          "generate",
          "--target",
          "sql",
          "--dialect",
          "supabase",
          ...extra,
          "--out",
          "rls.sql",
        ],
        { cwd },
      );
      expect(result.code).toBe(0);
      return readFileSync(join(cwd, "rls.sql"), "utf8");
    };
    const plain = await generate([
      "--memberships",
      "organization_members:organization_id,user_id,role",
    ]);
    expect(plain).not.toContain("permdock_ceiling");
    expect(plain).not.toContain("custom_role_permissions");
    const database = await generate([
      "--custom-roles",
      "--memberships",
      "organization_members:organization_id,user_id,role",
    ]);
    expect(database).toContain(
      'create table if not exists "permdock".custom_role_permissions',
    );
    expect(database).toContain(
      'create table if not exists "permdock".custom_role_includes',
    );
    expect(database).toContain("where rp.role = any(array['admin']::text[])");
    expect(database).toContain(
      "and not (m.\"role\"::text = any(array['admin', 'owner']::text[]))",
    );
    expect(database).toContain(
      'revoke execute on function "permdock".permdock_custom_keys(text[], text[], text[], text) from public, anon, authenticated;',
    );
    const jwt = await generate(["--custom-roles", "--authorize", "jwt"]);
    expect(jwt).toContain('create or replace view "permdock".permdock_ceiling');
    expect(jwt).toContain(
      "cross join lateral (select m -> 'grants' -> r.role as g) cg",
    );
    expect(jwt).not.toContain("custom_role_permissions");
    expect(jwt).not.toMatch(/service_role/iu);
  });

  it("emits authorize() and points to the supabase token hook with --rbac-scaffold", async () => {
    const cwd = miniAppCopy();
    const result = await run(
      [
        "rls",
        "generate",
        "--target",
        "sql",
        "--dialect",
        "supabase",
        "--rbac",
        "supabase",
        "--out",
        "rls.sql",
      ],
      { cwd },
    );
    expect(result.code).toBe(0);
    expect(result.stdout + result.stderr).toContain(
      "permdock supabase hook generate",
    );
    const sql = readFileSync(join(cwd, "rls.sql"), "utf8");
    expect(sql).not.toContain("custom_access_token_hook(event jsonb)");
    expect(sql).toContain('create or replace function "permdock"."authorize"(');
    expect(sql).toContain("requested_tenant text default null");
    expect(sql).toContain(`(select "permdock".permdock_has('post.read'))`);
    expect(sql).not.toMatch(/using \([^\n]*authorize\(/u);
    expect(sql).not.toMatch(/service_role/iu);
  });

  it("seeds top-level definePolicy({ grants }) into the rbac enums and role_permissions", async () => {
    const cwd = miniAppCopy();
    writeFileSync(
      join(cwd, "src/top-level-policy.ts"),
      `import { allow, definePolicy, plan } from 'permdock';
import { permissions } from './permissions.ts';

export const policy = definePolicy(permissions, {
  grants: [allow(permissions.post.read, { to: 'auditor' })],
  subject: () => null,
});

export const planPolicy = definePolicy(permissions, {
  grants: [allow(permissions.post.read, { to: plan('pro') })],
  subject: () => null,
});
`,
    );
    writeFileSync(
      join(cwd, "permdock.config.ts"),
      `export default {
  permissions: './src/permissions.ts',
  policy: './src/top-level-policy.ts',
};
`,
    );
    const result = await run(
      ["rls", "generate", "--rbac", "supabase", "--out", "rls.sql"],
      { cwd },
    );
    expect(result.code).toBe(0);
    const sql = readFileSync(join(cwd, "rls.sql"), "utf8");
    expect(sql).toContain(`as enum ('auditor')`);
    expect(sql).toContain(
      `('auditor', 'post.read', 'post.read', 'global', 'allow')`,
    );
    expect(sql).toContain(
      `using ((select "permdock".permdock_has('post.read')))`,
    );
  });

  it("rejects unknown --rbac values, bad --authorize and non-supabase dialects", async () => {
    const cwd = miniAppCopy();
    const base = ["rls", "generate", "--target", "sql", "--out", "rls.sql"];
    expect((await run([...base, "--rbac", "clerk"], { cwd })).code).toBe(2);
    expect(
      (
        await run([...base, "--rbac", "supabase", "--authorize", "cookie"], {
          cwd,
        })
      ).code,
    ).toBe(2);
    expect(
      (await run([...base, "--rbac", "supabase", "--dialect", "neon"], { cwd }))
        .code,
    ).toBe(2);
  });

  for (const mode of ["database", "jwt"] as const) {
    it(`matches the ${mode}-mode RBAC golden file (2 roles, 7 permissions)`, async () => {
      const cwd = miniAppCopy();
      writeFileSync(
        join(cwd, "src/rbac-policy.ts"),
        `import { allow, definePolicy, principal, role } from 'permdock';

import { permissions } from './permissions.ts';

const { post } = permissions;

const admin = role('admin', [
  allow(post.read),
  allow(post.update),
  allow(post.delete),
  allow(post.publish),
  allow(post.archive),
  allow(post.create),
  allow(post.list),
]);

const member = role(
  'member',
  [
    allow(post.read),
    allow(post.list),
    allow(post.create),
    allow(post.update, { where: { authorId: principal.id } }),
  ],
  { on: 'tenant' },
);

export const policy = definePolicy(permissions, {
  roles: [admin, member],
  scopes: { tenant: { key: 'orgId' } },
  subject: () => null,
});
`,
      );
      writeFileSync(
        join(cwd, "permdock.config.ts"),
        `export default {
  permissions: './src/permissions.ts',
  policy: './src/rbac-policy.ts',
};
`,
      );
      const result = await run(
        [
          "rls",
          "generate",
          "--target",
          "sql",
          "--dialect",
          "supabase",
          "--rbac",
          "supabase",
          "--authorize",
          mode,
          ...(mode === "jwt" ? ["--rbac-schema", "app"] : []),
          "--memberships",
          "organization_members:organization_id,user_id,role",
          "--out",
          "rls.sql",
        ],
        { cwd },
      );
      expect(result.code).toBe(0);
      const sql = readFileSync(join(cwd, "rls.sql"), "utf8");
      expect(sql).not.toMatch(/service_role/iu);
      await expect(sql).toMatchFileSnapshot(
        `./fixtures/golden/rbac-supabase-${mode}.sql`,
      );
    });
  }

  it("compiles neon and guc subject dialects", async () => {
    const cwd = miniAppCopy();
    const neon = await run(
      [
        "rls",
        "generate",
        "--target",
        "sql",
        "--dialect",
        "neon",
        "--out",
        "neon.sql",
      ],
      { cwd },
    );
    expect(neon.code).toBe(0);
    expect(readFileSync(join(cwd, "neon.sql"), "utf8")).toContain(
      "(select auth.user_id())",
    );
    const guc = await run(
      [
        "rls",
        "generate",
        "--target",
        "sql",
        "--dialect",
        "guc",
        "--guc-prefix",
        "app",
        "--out",
        "guc.sql",
      ],
      { cwd },
    );
    expect(guc.code).toBe(0);
    expect(readFileSync(join(cwd, "guc.sql"), "utf8")).toContain(
      "current_setting('app.user_id', true)",
    );
  });

  it("reads tenant memberships from the jwt claim when no table is mapped", async () => {
    const cwd = miniAppCopy();
    writeFileSync(
      join(cwd, "src/tenant-policy.ts"),
      `import { allow, definePolicy, role } from 'permdock';
import { permissions } from './permissions.ts';

const admin = role('admin', [allow(permissions.post.read)], { on: 'tenant' });

export const policy = definePolicy(permissions, {
  roles: [admin],
  scopes: { tenant: { key: 'orgId' } },
  subject: () => null,
});
`,
    );
    writeFileSync(
      join(cwd, "permdock.config.ts"),
      `export default {
  permissions: './src/permissions.ts',
  policy: './src/tenant-policy.ts',
};
`,
    );
    const result = await run(
      ["rls", "generate", "--target", "sql", "--out", "rls.sql"],
      { cwd },
    );
    expect(result.code).toBe(0);
    const sql = readFileSync(join(cwd, "rls.sql"), "utf8");
    expect(sql).toContain(
      `"orgId" in (select "permdock".permitted_tenant_ids('post.read'))`,
    );
    expect(sql).toContain("(select auth.jwt()) -> 'memberships'");
  });

  it("rejects an unknown generate target and import without --sql", async () => {
    const cwd = miniAppCopy();
    const target = await run(["rls", "generate", "--target", "mysql"], { cwd });
    expect(target.code).toBe(2);
    const imported = await run(["rls", "import"], { cwd });
    expect(imported.code).toBe(3);
    expect(imported.stderr).toContain("--sql");
  });

  it("writes drizzle and prisma targets", async () => {
    const cwd = miniAppCopy();
    const drizzle = await run(
      ["rls", "generate", "--target", "drizzle", "--out", "src/db/policies.ts"],
      { cwd },
    );
    expect(drizzle.code).toBe(0);
    const drizzleText = readFileSync(join(cwd, "src/db/policies.ts"), "utf8");
    expect(drizzleText).toContain("from 'drizzle-orm/supabase'");
    expect(drizzleText).not.toMatch(/Role[^\n]*from 'drizzle-orm\/pg-core'/u);
    expect(drizzleText).toMatch(/\}\)\.link\(schema\.\w+\)/u);
    expect(drizzleText).toContain("import * as schema from './schema'");
    expect(
      readFileSync(join(cwd, "src/db/policies.migration.sql"), "utf8"),
    ).toContain("enable row level security");
    const guc = await run(
      [
        "rls",
        "generate",
        "--target",
        "drizzle",
        "--dialect",
        "guc",
        "--out",
        "guc/policies.ts",
      ],
      { cwd },
    );
    expect(guc.code).toBe(0);
    const gucText = readFileSync(join(cwd, "guc/policies.ts"), "utf8");
    expect(gucText).toContain(
      "export const authenticatedRole = pgRole('authenticated').existing()",
    );
    expect(gucText).not.toContain("drizzle-orm/supabase");
    const prisma = await run(
      [
        "rls",
        "generate",
        "--target",
        "prisma",
        "--out",
        "prisma/policies.prisma",
      ],
      { cwd },
    );
    expect(prisma.code).toBe(0);
    const prismaText = readFileSync(
      join(cwd, "prisma/policies.prisma"),
      "utf8",
    );
    expect(prismaText).toMatch(/^\/\/ add @@rls to models? \w+/mu);
    expect(prismaText).toMatch(
      /^policy_select \w+ \{\n {2}target = \w+\n {2}roles {2}= \[/mu,
    );
    expect(prismaText).not.toMatch(/^model /mu);
  });

  it("emits sqlFunction calls and can inline the twin", async () => {
    const cwd = miniAppCopy();
    writeFileSync(
      join(cwd, "src/fn-policy.ts"),
      `import { allow, definePolicy, principal, role, sqlFunction } from 'permdock';
import { permissions } from './permissions.ts';

const member = role('member', [
  allow(permissions.post.read, {
    where: sqlFunction('job_permitted', {
      args: [{ field: 'id' }],
      twin: { authorId: principal.id },
    }),
  }),
]);

export const policy = definePolicy(permissions, {
  roles: [member],
  subject: () => null,
});
`,
    );
    writeFileSync(
      join(cwd, "permdock.config.ts"),
      `export default {
  permissions: './src/permissions.ts',
  policy: './src/fn-policy.ts',
};
`,
    );
    const generated = await run(
      ["rls", "generate", "--target", "sql", "--out", "rls.sql"],
      { cwd },
    );
    expect(generated.code).toBe(0);
    expect(generated.stdout).toContain("portable via twin");
    const sql = readFileSync(join(cwd, "rls.sql"), "utf8");
    expect(sql).toContain('"job_permitted"("id")');
    const inlined = await run(
      [
        "rls",
        "generate",
        "--target",
        "sql",
        "--inline-functions",
        "--out",
        "inline.sql",
      ],
      { cwd },
    );
    expect(inlined.code).toBe(0);
    expect(readFileSync(join(cwd, "inline.sql"), "utf8")).toContain(
      '"authorId" = (select "permdock".permdock_user_id())',
    );
  });
});
