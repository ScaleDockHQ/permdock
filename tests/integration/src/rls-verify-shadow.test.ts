import {
  hasBlockingDiagnostics,
  planSchemaFiles,
  rawProfile,
} from "@supabase/pg-delta";
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
import { Client, Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Postgres } from "./support/postgres.ts";

import { runPipingDbUrl } from "./db-url.ts";
import {
  CENTRAKIT,
  CUSTOM_ROLES,
  ROLES,
} from "./support/declarative-fixtures.ts";
import { databaseUri, startPostgres } from "./support/postgres.ts";
import { generated as generatedFiles } from "./support/rls.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "../fixtures/introspect");
const TMP = join(HERE, "../tmp");

const CLUSTER = `${ROLES}
grant authenticated to tester;
`;

const APP = `
grant usage on schema public to authenticated, anon;
create schema auth;
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;
grant usage on schema auth to authenticated, anon;
grant execute on all functions in schema auth to authenticated, anon;
create table public.doc (id text primary key, "orgId" uuid not null, tags text[] not null);
`;

describe("rls verify --shadow (pg-delta)", () => {
  let db: Postgres | undefined;
  let app = "";
  let generated = "";
  let databases = 0;

  beforeAll(async () => {
    mkdirSync(TMP, { recursive: true });
    app = mkdtempSync(join(TMP, "verify-shadow-"));
    cpSync(FIXTURE, app, { recursive: true });
    const schemas = join(app, "supabase/schemas");
    mkdirSync(schemas, { recursive: true });
    writeFileSync(join(schemas, "00_app.sql"), APP);
    const out = join(schemas, "10_permdock.sql");
    const result = await runPipingDbUrl(
      [
        "rls",
        "generate",
        "--target",
        "sql",
        "--dialect",
        "supabase",
        "--out",
        out,
      ],
      { cwd: app },
    );
    if (result.code !== 0) {
      throw new Error(`rls generate: ${result.stdout}${result.stderr}`);
    }
    generated = readFileSync(out, "utf8");
    db = await startPostgres([CLUSTER]);
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
    rmSync(app, { recursive: true, force: true });
  });

  async function database(statements: readonly string[]): Promise<string> {
    if (db === undefined) {
      throw new Error("PermDock: Postgres was not started");
    }
    databases += 1;
    const name = `shadow_case_${String(databases)}`;
    await db.admin.query(`create database ${name}`);
    const uri = databaseUri(db.uri, name);
    const client = new Client({ connectionString: uri });
    await client.connect();
    try {
      for (const statement of statements) {
        await client.query(statement);
      }
    } finally {
      await client.end();
    }
    return uri;
  }

  async function verify(live: string): Promise<{ code: number; out: string }> {
    const shadow = await database([]);
    const result = await runPipingDbUrl(
      ["rls", "verify", "--shadow", shadow, "--db-url", live],
      { cwd: app },
    );
    return { code: result.code, out: `${result.stdout}${result.stderr}` };
  }

  it("passes when the database matches the schema files", async () => {
    const result = await verify(await database([APP, generated]));
    expect(result.out).toContain("PermDock's policies, functions and grants");
    expect(result.code).toBe(0);
  }, 120_000);

  /**
   * What strict coverage blocks when pg-delta plans `files` from an empty
   * database. A reorder counts as blocked: it means a dependency the statements
   * do not show, which a `-- pg-topo:requires` line must name.
   */
  async function strictlyBlocked(
    files: { readonly name: string; readonly sql: string }[],
  ): Promise<{
    readonly blocked: readonly unknown[];
    readonly actions: number;
    readonly sql: string;
  }> {
    const target = new Pool({ connectionString: await database([]) });
    const shadow = new Pool({ connectionString: await database([]) });
    try {
      const result = await planSchemaFiles(target, shadow, files, {
        profile: rawProfile,
        statementFallback: false,
      });
      const blocked = [
        ...result.loadDiagnostics,
        ...result.targetDiagnostics,
        ...result.driftDiagnostics,
        ...result.skipped,
      ].filter(
        (item) =>
          !("code" in item) ||
          item.code === "reorder_on_failure" ||
          hasBlockingDiagnostics([item], { strictCoverage: true }),
      );
      return {
        blocked,
        actions: result.plan.actions.length,
        sql: result.plan.actions.map((action) => action.sql).join(";\n"),
      };
    } finally {
      await Promise.all([target.end(), shadow.end()]);
    }
  }

  it("plans the generated tree under strict coverage with nothing pg-delta cannot model", async () => {
    const result = await strictlyBlocked([
      { name: "00_app.sql", sql: APP },
      { name: "10_permdock.sql", sql: generated },
    ]);
    expect(result.blocked).toStrictEqual([]);
    expect(result.actions).toBeGreaterThan(0);
  }, 120_000);

  it("loads the powersync publication file next to a declared publication", async () => {
    const result = await strictlyBlocked([
      {
        name: "public/powersync.sql",
        sql: "create publication powersync for tables in schema public;",
      },
      {
        name: "permdock/roles.sql",
        sql: "create schema permdock; create table permdock.user_roles (user_id uuid primary key);",
      },
      {
        name: "permdock/powersync_publication.sql",
        sql: "-- Generated by permdock powersync generate from the policy. Do not edit.\nalter publication powersync add table permdock.user_roles;\n",
      },
    ]);
    expect(result.blocked).toStrictEqual([]);
    expect(result.sql).toMatch(
      /publication "powersync"[^;]*"permdock"\."user_roles"/iu,
    );
  }, 120_000);

  for (const [fixture, setup, split] of [
    ["rls-custom-roles", CUSTOM_ROLES, "helpers"],
    ["centrakit-roles", CENTRAKIT, "helpers,hook"],
  ] as const) {
    it(`plans the ${split} parts under strict coverage (${fixture})`, async () => {
      const parts = await generatedFiles(
        [
          "rls",
          "generate",
          "--target",
          "sql",
          "--split",
          `${split},seeds`,
          "--out",
          "{dir}/{part}.sql",
          "--seeds-out",
          "{dir}/seeds.sql",
        ],
        split.split(",").map((part) => `${part}.sql`),
        { cwd: join(HERE, "../fixtures", fixture) },
      );
      const result = await strictlyBlocked([
        { name: "00_setup.sql", sql: setup },
        ...parts.map((sql, index) => ({
          name: `1${String(index)}_part.sql`,
          sql,
        })),
      ]);
      expect(result.blocked).toStrictEqual([]);
      expect(result.actions).toBeGreaterThan(0);
    }, 120_000);
  }

  it("reports a changed policy and a revoked helper grant, and not the app's own drift", async () => {
    const live = await database([APP, generated]);
    const client = new Client({ connectionString: live });
    await client.connect();
    let policy = "";
    try {
      const rows = await client.query<{ readonly policyname: string }>(
        "select policyname from pg_policies where tablename = 'doc' order by policyname limit 1",
      );
      policy = rows.rows[0]?.policyname ?? "";
      await client.query(
        `alter policy ${JSON.stringify(policy)} on public.doc using (true)`,
      );
      await client.query(
        "revoke execute on all functions in schema permdock from authenticated",
      );
      await client.query("alter table public.doc add column note text");
    } finally {
      await client.end();
    }
    expect(policy).not.toBe("");
    const result = await verify(live);
    expect(result.code).toBe(1);
    expect(result.out).toContain(`shadow-differs:public.doc:`);
    expect(result.out).toContain(policy);
    expect(result.out).toMatch(/shadow-missing:permdock:/u);
    expect(result.out).not.toContain("note");
  }, 120_000);
});
