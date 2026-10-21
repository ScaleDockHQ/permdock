import { PGlite } from "@electric-sql/pglite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPermDock } from "permdock";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  permissions,
  policy,
} from "../fixtures/resource-member-columns/policy.ts";
import { generateRls } from "./support/rls.ts";

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/resource-member-columns",
);

// `project_members` has its own `id` and a `project_id`, the same names the
// guarded rows use: a membership check must still compare against the row.
const SETUP = `
create role authenticated nologin;
create role anon nologin;
grant usage on schema public to authenticated;
create table project_members (id text primary key, project_id text not null, user_id text not null, role text not null);
create table project (id text primary key);
create table task (id text primary key, project_id text not null);
insert into project values ('pa'), ('pb'), ('m1');
insert into task values ('ta', 'pa'), ('tb', 'pb');
insert into project_members values ('m1', 'pa', 'alice', 'viewer'), ('m2', 'pb', 'bob', 'viewer');
grant select on project, task, project_members to authenticated;
`;

describe("a resource memberships table with the row's column names", () => {
  let lite: PGlite | undefined;

  beforeAll(async () => {
    lite = new PGlite();
    await lite.exec(SETUP);
    await lite.exec(await generateRls(FIXTURE));
  }, 60_000);

  afterAll(async () => {
    await lite?.close();
  });

  async function visible(user: string, table: string): Promise<string[]> {
    if (lite === undefined) {
      throw new Error("PermDock: PGlite did not start");
    }
    await lite.exec("begin; set local role authenticated;");
    try {
      await lite.query("select set_config('app.user_id', $1, true)", [user]);
      const result = await lite.query<{ readonly id: string }>(
        `select id from ${table} order by id`,
      );
      return result.rows.map((row) => row.id);
    } finally {
      await lite.exec("rollback");
    }
  }

  it.each([
    ["alice", "project", ["pa"]],
    ["alice", "task", ["ta"]],
    ["bob", "project", ["pb"]],
    ["bob", "task", ["tb"]],
    ["carol", "project", []],
    ["carol", "task", []],
  ])("%s reads only their own %s rows", async (user, table, expected) => {
    expect(await visible(user, table)).toStrictEqual(expected);
  });

  it("matches the in-process decision", async () => {
    const alice = await getPermDock(policy, {
      id: "alice",
      memberships: [
        { on: { resource: "project", id: "pa" }, roles: ["viewer"] },
      ],
    });
    const rows = [
      { id: "ta", project_id: "pa" },
      { id: "tb", project_id: "pb" },
    ];
    expect(
      rows
        .filter((row) => alice.can(permissions.task.read, row))
        .map((row) => row.id),
    ).toStrictEqual(await visible("alice", "task"));
  });
});
