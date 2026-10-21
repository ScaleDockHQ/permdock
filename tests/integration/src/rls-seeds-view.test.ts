import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "permdock/cli";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Postgres } from "./support/postgres.ts";

import { startPostgres, databaseUri } from "./support/postgres.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../fixtures");

const ROLES = `
create role authenticated nologin;
create role anon nologin;
grant authenticated to tester;
`;

const SETUP = `
create table staff_members (org_id text not null, user_id text not null, role text not null);
create table doc (id text primary key, org_id text not null);
`;

const ROWS =
  "select role, permission, grant_key, scope, effect from permdock.role_permissions order by role, grant_key, scope";

describe("rls.seeds: 'view'", () => {
  let db: Postgres | undefined;
  const sql = new Map<string, string>();

  async function load(name: string, cwd: string): Promise<void> {
    if (db === undefined) {
      throw new Error("PermDock: Postgres was not started");
    }
    const dir = mkdtempSync(join(tmpdir(), "permdock-seeds-view-"));
    try {
      const out = join(dir, `${name}.sql`);
      const result = await run(
        ["rls", "generate", "--target", "sql", "--out", out],
        { cwd },
      );
      if (result.code !== 0) {
        throw new Error(`rls generate: ${result.stdout}${result.stderr}`);
      }
      sql.set(name, readFileSync(out, "utf8"));
      await db.admin.query(`create database ${name}`);
      const client = new Client({
        connectionString: databaseUri(db.uri, name),
      });
      await client.connect();
      try {
        await client.query(`${SETUP}\n${sql.get(name) ?? ""}`);
      } finally {
        await client.end();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  async function rows(name: string, text: string): Promise<unknown[]> {
    if (db === undefined) {
      throw new Error("PermDock: Postgres was not started");
    }
    const client = new Client({ connectionString: databaseUri(db.uri, name) });
    await client.connect();
    try {
      return (await client.query(text)).rows;
    } finally {
      await client.end();
    }
  }

  beforeAll(async () => {
    db = await startPostgres([ROLES]);
    await load("seeds_table", join(FIXTURES, "constant-via"));
    await load("seeds_view", join(FIXTURES, "seeds-view"));
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  });

  it("writes a security_invoker view where the table was", async () => {
    expect(sql.get("seeds_view")).toContain("create or replace view");
    expect(sql.get("seeds_view")).not.toContain(
      'create table if not exists "permdock"."role_permissions"',
    );
    expect(
      await rows(
        "seeds_view",
        `select c.relkind, c.reloptions from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'permdock' and c.relname = 'role_permissions'`,
      ),
    ).toStrictEqual([{ relkind: "v", reloptions: ["security_invoker=true"] }]);
  });

  it("answers the same rows as the seeded table", async () => {
    const table = await rows("seeds_table", ROWS);
    expect(table.length).toBeGreaterThan(0);
    expect(await rows("seeds_view", ROWS)).toStrictEqual(table);
  });

  it("stays unreadable to the client roles", async () => {
    await expect(
      rows(
        "seeds_view",
        `set role authenticated; select 1 from permdock.role_permissions`,
      ),
    ).rejects.toThrow(/permission denied/u);
  });
});
