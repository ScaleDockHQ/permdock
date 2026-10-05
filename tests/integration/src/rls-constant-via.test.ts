import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPermDock } from "permdock";
import { run } from "permdock/cli";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Postgres } from "./support/postgres.ts";

import { permissions, policy } from "../fixtures/constant-via/policy.ts";
import { startPostgres } from "./support/postgres.ts";

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/constant-via",
);

const ROLES = `
create role authenticated nologin;
create role anon nologin;
grant authenticated to tester;
`;

const TABLES = `
create table staff_members (org_id text not null, user_id text not null, role text not null);
create table contact_members (org_id text not null, user_id text not null, role text not null);
create table doc (id text primary key, org_id text not null);
insert into staff_members values ('o1', 'u1', 'admin');
insert into contact_members values ('o1', 'u1', 'admin');
insert into doc values ('d1', 'o1'), ('d2', 'o2');
grant usage on schema public to authenticated;
grant select on doc to authenticated;
`;

const SHAPES = [
  { name: "staff_table", cwd: FIXTURE, via: "staff" },
  { name: "contact_table", cwd: join(FIXTURE, "contact"), via: "contact" },
] as const;

function databaseUri(uri: string, database: string): string {
  const url = new URL(uri);
  url.pathname = `/${database}`;
  return url.toString();
}

describe("a constant via on an rls.memberships table", () => {
  let db: Postgres | undefined;

  beforeAll(async () => {
    db = await startPostgres([ROLES]);
    const dir = mkdtempSync(join(tmpdir(), "permdock-constant-via-"));
    try {
      for (const shape of SHAPES) {
        const out = join(dir, `${shape.name}.sql`);
        const result = await run(
          ["rls", "generate", "--target", "sql", "--out", out],
          { cwd: shape.cwd },
        );
        if (result.code !== 0) {
          throw new Error(`rls generate: ${result.stdout}${result.stderr}`);
        }
        await db.admin.query(`create database ${shape.name}`);
        const client = new Client({
          connectionString: databaseUri(db.uri, shape.name),
        });
        await client.connect();
        try {
          await client.query(`${TABLES}\n${readFileSync(out, "utf8")}`);
        } finally {
          await client.end();
        }
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  });

  it.each(SHAPES)(
    "$name: a role with for applies only when the constant kind is listed",
    async (shape) => {
      if (db === undefined) {
        throw new Error("PermDock: Postgres was not started");
      }
      const url = new URL(databaseUri(db.uri, shape.name));
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
            "select id from doc order by id",
          )
        ).rows.map((row) => row.id);
        await client.query("rollback");
        const permdock = await createPermDock(policy, {
          id: "u1",
          tenant: "o1",
          memberships: [
            { scope: "org", id: "o1", roles: ["admin"], via: shape.via },
          ],
        });
        const expected = ["d1", "d2"].filter((id) =>
          permdock.can(permissions.doc.read, {
            id,
            org_id: id === "d1" ? "o1" : "o2",
          }),
        );
        expect(visible).toEqual(expected);
        expect(visible).toEqual(shape.via === "staff" ? ["d1"] : []);
      } finally {
        await client.end();
      }
    },
  );
});
