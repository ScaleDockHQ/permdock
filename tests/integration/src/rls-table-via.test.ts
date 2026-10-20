import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPermDock } from "permdock";
import { run } from "permdock/cli";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Postgres } from "./support/postgres.ts";

import { permissions, policy } from "../fixtures/table-via/policy.ts";
import { startPostgres, databaseUri } from "./support/postgres.ts";

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/table-via",
);

const ROLES = `
create role authenticated nologin;
create role anon nologin;
grant authenticated to tester;
`;

// The caller reads neither cloud.environments nor members: the helper is the only way in.
const TABLES = `
create schema cloud;
create table cloud.environments (id text primary key, org_id text not null);
create table members (org_id text not null, user_id text not null, role text not null);
create table deployments (id text primary key, environment_id text not null);
insert into cloud.environments values ('e1', 'o1'), ('e2', 'o2');
insert into members values ('o1', 'u1', 'admin');
insert into deployments values ('d1', 'e1'), ('d2', 'e2'), ('d3', 'e1');
grant usage on schema public to authenticated;
grant select on deployments to authenticated;
`;

describe("rls.tables via", () => {
  let db: Postgres | undefined;
  let sql = "";

  beforeAll(async () => {
    db = await startPostgres([ROLES]);
    const dir = mkdtempSync(join(tmpdir(), "permdock-table-via-"));
    try {
      const out = join(dir, "via.sql");
      const result = await run(
        ["rls", "generate", "--target", "sql", "--out", out],
        { cwd: FIXTURE },
      );
      if (result.code !== 0) {
        throw new Error(`rls generate: ${result.stdout}${result.stderr}`);
      }
      sql = readFileSync(out, "utf8");
      await db.admin.query("create database via_db");
      const setup = new Client({
        connectionString: databaseUri(db.uri, "via_db"),
      });
      await setup.connect();
      try {
        await setup.query(`${TABLES}\n${sql}`);
      } finally {
        await setup.end();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  });

  it("writes the parent helper, its grants and a policy over it", () => {
    expect(sql).toMatch(/function "?permdock"?\.permitted_environment_ids\(/u);
    expect(sql).toContain("security definer");
    expect(sql).toMatch(
      /grant execute on function "?permdock"?\.permitted_environment_ids\(text\) to authenticated/u,
    );
    expect(sql).toMatch(
      /"environment_id" in \(select "?permdock"?\.permitted_environment_ids\('deploy\.read'\)\)/u,
    );
  });

  it("shows the rows the in-process decision allows", async () => {
    if (db === undefined) {
      throw new Error("PermDock: Postgres was not started");
    }
    const url = new URL(databaseUri(db.uri, "via_db"));
    url.username = "tester";
    url.password = "tester";
    const client = new Client({ connectionString: url.toString() });
    await client.connect();
    try {
      await client.query("begin");
      await client.query("set local role authenticated");
      await client.query("select set_config('app.user_id', 'u1', true)");
      const visible = (
        await client.query<{ readonly id: string }>(
          "select id from deployments order by id",
        )
      ).rows.map((row) => row.id);
      await client.query("rollback");
      const permdock = await getPermDock(policy, {
        id: "u1",
        tenant: "o1",
        memberships: [{ scope: "org", id: "o1", roles: ["admin"] }],
      });
      const orgOf: Record<string, string> = { d1: "o1", d2: "o2", d3: "o1" };
      const expected = Object.keys(orgOf).filter((id) =>
        permdock.can(permissions.deploy.read, { id, org_id: orgOf[id] ?? "" }),
      );
      expect(visible).toEqual(expected);
      expect(visible).toEqual(["d1", "d3"]);
    } finally {
      await client.end();
    }
  });
});
