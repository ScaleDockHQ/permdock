import { testAuthorizationProvider } from "better-supabase/testing";
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { authorizationProvider } from "permdock/better-supabase";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Postgres17 } from "./support/postgres-17.ts";

import config from "../fixtures/better-supabase-provider-only/better-supabase.config.ts";
import { permissions } from "../fixtures/better-supabase-provider-only/permissions.ts";
import { run } from "./support/cli-run.ts";
import { defined } from "./support/defined.ts";
import { startPostgres17 } from "./support/postgres-17.ts";

const FIXTURE = join(
  import.meta.dirname,
  "../fixtures/better-supabase-provider-only",
);
const BIN = join(import.meta.dirname, "../node_modules/.bin/better-supabase");

/** The schema files in the order `supabase db reset` would need them. */
const SCHEMAS = [
  "public/tables/app.sql",
  "900_better_supabase_000_prelude.sql",
  "permdock/helpers.sql",
  "permdock/indexes.sql",
  "permdock/functions/custom_access_token_hook.sql",
  "public/policies/permdock.sql",
  "900_better_supabase_019_permissions.sql",
];

const MIGRATIONS = readdirSync(join(FIXTURE, "supabase/migrations"))
  .filter((file) => file.endsWith(".sql"))
  .toSorted();

const read = (file: string): string =>
  readFileSync(join(FIXTURE, file), "utf8");

const provider = authorizationProvider({
  manifest: read("permdock.manifest.json"),
  catalog: read("permissions.catalog.json"),
  permissions,
  personas: "roles",
});

const LITERALS: Readonly<Record<string, string>> = {
  permission: "'projects.read'",
  user: "'00000000-0000-4000-8000-0000000000a1'::uuid",
  role: "'member'",
  tenant: "'acme'",
  resource: "'organization'",
  id: "'acme'",
};

function betterSupabase(
  args: readonly string[],
  input?: string,
): { readonly status: number | null; readonly output: string } {
  const result = spawnSync(BIN, [...args, "--agent", "no", "--no-color"], {
    cwd: FIXTURE,
    encoding: "utf8",
    ...(input === undefined ? {} : { input }),
    // better-supabase reads SUPABASE_DB_URL only when DATABASE_URL is unset; the caller's shell must not win.
    env: { ...process.env, DATABASE_URL: "", SUPABASE_DB_URL: "" },
  });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe("a better-supabase app that takes every authorization slot from the provider", () => {
  let database: Postgres17 | undefined;

  beforeAll(async () => {
    database = await startPostgres17();
    const client = new Client({ connectionString: database.url });
    await client.connect();
    try {
      for (const file of [
        "auth-stub.sql",
        ...SCHEMAS.map((schema) => `supabase/schemas/${schema}`),
        ...MIGRATIONS.map((migration) => `supabase/migrations/${migration}`),
      ]) {
        await client.query(read(file));
      }
    } finally {
      await client.end();
    }
  }, 300_000);

  afterAll(async () => {
    await database?.stop();
  });

  it("loads every schema file", () => {
    const files = readdirSync(join(FIXTURE, "supabase/schemas"), {
      recursive: true,
      encoding: "utf8",
    }).filter((file) => file.endsWith(".sql"));
    expect(files.toSorted()).toStrictEqual(SCHEMAS.toSorted());
  });

  it("keeps the catalog, the manifest and the PermDock SQL current", async () => {
    for (const argv of [
      ["catalog", "--out", "permissions.catalog.json", "--check"],
      ["supabase", "inspect", "--out", "permdock.manifest.json", "--check"],
      ["generate", "--only", "rls", "--check"],
    ]) {
      const result = await run(argv, { cwd: FIXTURE });
      expect({
        argv,
        code: result.code,
        ...(result.code === 0
          ? {}
          : { output: `${result.stdout}${result.stderr}` }),
      }).toStrictEqual({ argv, code: 0 });
    }
  });

  it("names nothing but the provider and the blocks in its config", () => {
    expect(Object.keys(config).toSorted()).toStrictEqual([
      "auth",
      "blocks",
      "database",
      "tooling",
    ]);
    expect(Object.keys(config.auth ?? {})).toStrictEqual(["authorization"]);
    expect(config.auth?.authorization).toStrictEqual(provider);
    expect(config.blocks?.permissions).toStrictEqual({
      model: "provider",
      activeTenant: "claim",
    });
  });

  it("fills memberships, suspension, platform roles, the subject, personas and the approval sets", () => {
    expect(provider.problems).toBeUndefined();
    expect(provider.memberships).toStrictEqual([
      {
        table: "public.memberships",
        userColumn: "user_id",
        scope: { column: "scope" },
        idColumn: "scope_id",
      },
    ]);
    expect(provider.suspension).toStrictEqual({
      user: { table: "public.profiles", id: "id", disabledAt: "disabled_at" },
      userKey: "id",
      tenant: {
        table: "public.organizations",
        id: "id",
        disabledAt: "disabled_at",
      },
    });
    expect(provider.platformRoles).toStrictEqual({
      table: "public.platform_roles",
      user: "user_id",
      role: "role",
    });
    expect(provider.personas).toBe("roles");
    expect(provider.fixtureRoles?.map((role) => role.name)).toStrictEqual([
      "member",
      "owner",
    ]);
    expect(provider.functions).toMatchObject({
      subject: "permdock.permdock_subject()",
      subjectForTenant: "permdock.permdock_subject(({tenant})::text)",
      bootstrapPermissions:
        "permdock.permdock_bootstrap_permissions(({tenant})::text)",
      approverFor: "permdock.permdock_approver_for_ids()",
      managedUsers: "permdock.permdock_managed_user_ids({tenant})",
      canAssign: "permdock.permdock_can_assign({role}, {tenant}::text)",
    });
  });

  it("passes better-supabase's conformance kit", async () => {
    const report = await testAuthorizationProvider(provider);
    expect(report.checks.length).toBeGreaterThan(0);
  });

  it("finds every required function, executable by its role", async () => {
    const client = new Client({ connectionString: defined(database).url });
    await client.connect();
    try {
      for (const { function: fn, args, role } of provider.requires ?? []) {
        const signature = `${fn}(${args ?? ""})`;
        const { rows } = await client.query<{
          found: boolean;
          executable: boolean | null;
        }>(
          `select to_regprocedure($1) is not null as found,
             case when to_regprocedure($1) is not null
               then has_function_privilege($2, $1, 'execute') end as executable`,
          [signature, role],
        );
        expect({ signature, ...rows[0] }).toStrictEqual({
          signature,
          found: true,
          executable: true,
        });
      }
    } finally {
      await client.end();
    }
  });

  it("runs every template at every scope", async () => {
    const client = new Client({ connectionString: defined(database).url });
    await client.connect();
    try {
      for (const [name, template] of Object.entries(provider.functions)) {
        if (template === undefined) continue;
        for (const { name: scope } of provider.scopes) {
          const sql = template
            .replaceAll("{scope}", scope)
            .replaceAll(
              /\{(\w+)\}/gu,
              (_: string, key: string) => LITERALS[key] ?? "null",
            );
          await expect(
            client.query(`select ${sql}`),
            `${name} at ${scope}`,
          ).resolves.toBeDefined();
        }
      }
    } finally {
      await client.end();
    }
  });

  it("is current for better-supabase upgrade --check", () => {
    expect(betterSupabase(["upgrade", "--check"])).toMatchObject({ status: 0 });
  });

  it("passes better-supabase doctor --fail-on warning", () => {
    const result = betterSupabase(
      ["doctor", "--fail-on", "warning", "--db-url-stdin"],
      defined(database).url,
    );
    expect(result).toMatchObject({
      status: 0,
      output: expect.stringMatching(/\b0 errors, 0 warnings\b/u),
    });
  });
});
