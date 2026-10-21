import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { PermDockConfig } from "../../src/cli/types.ts";

import { run } from "../../src/cli/core/run.ts";
import { pd054 } from "../../src/cli/doctor/seeds.ts";
import { project, removeProjects } from "./doctor-kit.ts";

afterAll(removeProjects);

const POLICY = path.join(import.meta.dirname, "../fixtures/named-scopes.ts");
const SEEDS = "supabase/migrations/20260101000001_permdock_seeds.sql";
const config: PermDockConfig = {
  permissions: POLICY,
  policy: POLICY,
  rls: { dialect: "supabase" },
};

const LEVELLED = `import { allow, definePermissions, definePolicy, principal, resource, role } from 'permdock';

export const permissions = definePermissions({
  job: resource({
    id: 'id',
    actions: ['read', 'update'],
    relations: { org: { field: 'orgId', memberOf: 'tenant' } },
    levels: { own: { ownerId: principal.id }, all: {} },
  }),
});

export const policy = definePolicy(permissions, {
  roles: [
    role('admin', [allow([permissions.job.read, permissions.job.update])], { on: 'tenant' }),
  ],
  scopes: { tenant: { key: 'orgId' } },
  subject: () => null,
});
`;

async function seeded(): Promise<string> {
  const cwd = project({
    "permdock.config.ts": `export default ${JSON.stringify(config)};\n`,
  });
  const result = await run(
    [
      "rls",
      "generate",
      "--split",
      "helpers,seeds",
      "--out",
      "supabase/schemas/permdock_{part}.sql",
      "--seeds-out",
      SEEDS,
    ],
    { cwd },
  );
  expect(result.code).toBe(0);
  return cwd;
}

describe("PD054 stale role_permissions seeds", () => {
  it("is quiet when the last seed matches the policy, and names missing and stale rows", async () => {
    const cwd = await seeded();
    expect(await pd054({ cwd, config })).toStrictEqual([]);
    const file = path.join(cwd, SEEDS);
    const sql = readFileSync(file, "utf8");
    const edited = sql
      .replace(/^ {2}\('owner', 'quote\.read'.*,\n/mu, "")
      .replace(
        "values\n",
        "values\n  ('ghost', 'quote.read', 'quote.read', 'organization', 'allow'),\n",
      );
    expect(edited).not.toBe(sql);
    writeFileSync(file, edited);
    const [finding] = await pd054({ cwd, config });
    expect(finding?.code).toBe("PD054");
    expect(finding?.message).toContain(
      `${SEEDS} seeds permdock.role_permissions with rows the policy no longer compiles to: 1 missing, such as (owner quote.read quote.read#1 organization allow); 1 stale, such as (ghost quote.read quote.read organization allow)`,
    );
  });

  it("reads a later migration that clears the table as the latest seed", async () => {
    const cwd = await seeded();
    writeFileSync(
      path.join(cwd, "supabase/migrations/20260102000000_clear.sql"),
      "delete from permdock.role_permissions;\n",
    );
    const [finding] = await pd054({ cwd, config });
    expect(finding?.message).toMatch(/: \d+ missing, such as/u);
  });

  it("leaves a config rls generate refuses or cannot compile to rls generate", async () => {
    const cwd = await seeded();
    writeFileSync(
      path.join(cwd, SEEDS),
      "delete from permdock.role_permissions;\n",
    );
    expect(
      await pd054({
        cwd,
        config: { ...config, rls: { ...config.rls, revokeColumns: true } },
      }),
    ).toStrictEqual([]);
    expect(
      await pd054({
        cwd,
        config: { ...config, rls: { ...config.rls, trustedReaders: [""] } },
      }),
    ).toStrictEqual([]);
  });

  it("compiles a supabase-only config with Supabase defaults and names stale rows alone", async () => {
    const cwd = await seeded();
    const file = path.join(cwd, SEEDS);
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace(
        "values\n",
        "values\n  ('ghost', 'quote.read', 'quote.read', 'organization', 'allow'),\n",
      ),
    );
    writeFileSync(
      path.join(cwd, "supabase/migrations/20260102000000_other.sql"),
      "insert into public.notes (id) values ('n1');\ndelete from public.notes;\n",
    );
    const [finding] = await pd054({
      cwd,
      config: { permissions: POLICY, policy: POLICY, supabase: {} },
    });
    expect(finding?.message).toContain(
      "rows the policy no longer compiles to: 1 stale, such as (ghost quote.read quote.read organization allow)",
    );
    expect(finding?.message).not.toContain("missing");
  });

  it("needs a policy, an rls or supabase config, and a seed in the migrations", async () => {
    expect(await pd054({ cwd: project({}), config })).toStrictEqual([]);
    expect(
      await pd054({ cwd: await seeded(), config: { policy: POLICY } }),
    ).toStrictEqual([]);
    expect(
      await pd054({
        cwd: await seeded(),
        config: { ...config, policy: "src/missing-policy.ts" },
      }),
    ).toStrictEqual([]);
  });

  it.each([
    ["unset", undefined, SEEDS],
    [
      "'function'",
      "function",
      "supabase/migrations/20260101000001_helpers.sql",
    ],
    ["'view'", "view", "supabase/migrations/20260101000001_helpers.sql"],
  ] as const)(
    "compiles a levelled resource as generate does with rls.seeds %s",
    async (_label, seeds, file) => {
      const levelConfig: PermDockConfig = {
        permissions: "./src/levels.ts",
        policy: "./src/levels.ts",
        rls: {
          dialect: "supabase",
          tenantType: "text",
          customRoles: true,
          rowHelpers: true,
          memberships: {
            tenant: {
              table: "organization_members",
              tenant: "organization_id",
              user: "user_id",
              role: "role",
            },
          },
          ...(seeds === undefined ? {} : { seeds }),
        },
      };
      const cwd = project({
        "permdock.config.ts": `export default ${JSON.stringify(levelConfig)};\n`,
        "src/levels.ts": LEVELLED,
      });
      const result = await run(
        [
          "rls",
          "generate",
          "--split",
          seeds === undefined ? "helpers,seeds" : "helpers",
          "--out",
          "supabase/migrations/20260101000001_{part}.sql",
          ...(seeds === undefined ? ["--seeds-out", SEEDS] : []),
        ],
        { cwd },
      );
      expect(result.code).toBe(0);
      expect(await pd054({ cwd, config: levelConfig })).toStrictEqual([]);

      const target = path.join(cwd, file);
      const sql = readFileSync(target, "utf8");
      const ghost = "  ('ghost', 'job.read', 'job.read', 'tenant', 'allow'),\n";
      const edited = sql.replace(/values\n/u, `values\n${ghost}`);
      expect(edited).not.toBe(sql);
      writeFileSync(target, edited);
      const [finding] = await pd054({ cwd, config: levelConfig });
      expect(finding?.message).toContain(
        "1 stale, such as (ghost job.read job.read tenant allow)",
      );
    },
  );

  it("generates the seed function with the helpers, and PD054 reads its body", async () => {
    const fnConfig: PermDockConfig = {
      ...config,
      rls: { dialect: "supabase", seeds: "function" },
    };
    const cwd = project({
      "permdock.config.ts": `export default ${JSON.stringify(fnConfig)};\n`,
    });
    const result = await run(
      [
        "rls",
        "generate",
        "--split",
        "helpers",
        "--out",
        "supabase/migrations/20260101000001_permdock_{part}.sql",
      ],
      { cwd },
    );
    expect(result.code).toBe(0);
    const file = path.join(
      cwd,
      "supabase/migrations/20260101000001_permdock_helpers.sql",
    );
    const sql = readFileSync(file, "utf8");
    expect(sql).toContain('create or replace function "permdock".seed()');
    expect(sql).toContain("security definer");
    expect(sql).toContain(
      'revoke execute on function "permdock".seed() from public, anon, authenticated;',
    );
    expect(await pd054({ cwd, config: fnConfig })).toStrictEqual([]);

    writeFileSync(
      file,
      sql.replace(
        "values\n",
        "values\n  ('ghost', 'quote.read', 'quote.read', 'organization', 'allow'),\n",
      ),
    );
    const [finding] = await pd054({ cwd, config: fnConfig });
    expect(finding?.message).toContain(
      "1 stale, such as (ghost quote.read quote.read organization allow)",
    );
  });
});
