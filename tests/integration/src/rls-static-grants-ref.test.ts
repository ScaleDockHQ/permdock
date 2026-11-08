import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getPermDock } from "permdock";
import { run } from "permdock/cli";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Postgres } from "./support/postgres.ts";

import {
  permissions,
  policy,
} from "../fixtures/static-grants-inline/policy.ts";
import { startPostgres, databaseUri } from "./support/postgres.ts";
import { rlsGenerate } from "./support/rls.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "../fixtures");
const INLINE = join(FIXTURES, "static-grants-inline");
const REF = join(FIXTURES, "static-grants-ref");

const ROLES = `
create role authenticated nologin;
create role anon nologin;
grant authenticated to tester;
`;

const TABLES = `
create table staff_members (org_id text not null, user_id text not null, role text not null);
create table doc (id text primary key, org_id text not null, title text not null default '');
insert into staff_members values
  ('o1', 'admin1', 'admin'), ('o1', 'editor1', 'editor'), ('o1', 'viewer1', 'viewer'),
  ('o2', 'admin2', 'admin');
insert into doc (id, org_id) values ('d1', 'o1'), ('d2', 'o1'), ('d3', 'o2');
grant usage on schema public to authenticated;
grant select, update, delete on doc to authenticated;
`;

const USERS = ["admin1", "editor1", "viewer1", "admin2", "stranger"] as const;
const DOCS = [
  { id: "d1", org_id: "o1" },
  { id: "d2", org_id: "o1" },
  { id: "d3", org_id: "o2" },
] as const;

type Outcome = {
  readonly read: readonly string[];
  readonly update: readonly string[];
  readonly delete: readonly string[];
};

describe("rls.staticGrants: 'ref'", () => {
  let db: Postgres | undefined;
  const sql = new Map<string, string>();
  let loader = "";
  let bundle = "";
  let hash = "";

  function postgres(): Postgres {
    if (db === undefined) {
      throw new Error("PermDock: Postgres was not started");
    }
    return db;
  }

  async function generate(cwd: string): Promise<string> {
    const dir = mkdtempSync(join(tmpdir(), "permdock-static-grants-"));
    try {
      const out = join(dir, "out.sql");
      const result = await rlsGenerate(["--target", "sql", "--out", out], {
        cwd,
      });
      if (result.code !== 0) {
        throw new Error(`rls generate: ${result.stdout}${result.stderr}`);
      }
      return readFileSync(out, "utf8");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  async function createDatabase(name: string, text: string): Promise<void> {
    await postgres().admin.query(`create database ${name}`);
    const client = new Client({
      connectionString: databaseUri(postgres().uri, name),
    });
    await client.connect();
    try {
      await client.query(`${TABLES}\n${text}`);
    } finally {
      await client.end();
    }
  }

  async function asUser(
    name: string,
    user: string,
    text: string,
  ): Promise<readonly string[]> {
    const url = new URL(databaseUri(postgres().uri, name));
    url.username = "tester";
    url.password = "tester";
    const client = new Client({ connectionString: url.toString() });
    await client.connect();
    try {
      await client.query("begin");
      await client.query("set local role authenticated");
      await client.query("select set_config('app.user_id', $1, true)", [user]);
      const { rows } = await client.query<{ readonly id: string }>(text);
      await client.query("rollback");
      return rows.map((row) => row.id);
    } finally {
      await client.end();
    }
  }

  async function outcome(name: string, user: string): Promise<Outcome> {
    return {
      read: await asUser(name, user, "select id from doc order by id"),
      update: await asUser(
        name,
        user,
        "update doc set title = 'x' returning id",
      ).then((ids) => ids.toSorted()),
      delete: await asUser(name, user, "delete from doc returning id").then(
        (ids) => ids.toSorted(),
      ),
    };
  }

  async function admin(name: string, text: string): Promise<void> {
    const client = new Client({
      connectionString: databaseUri(postgres().uri, name),
    });
    await client.connect();
    try {
      await client.query(text);
    } finally {
      await client.end();
    }
  }

  beforeAll(async () => {
    db = await startPostgres([ROLES]);
    sql.set("inline", await generate(INLINE));
    sql.set("ref", await generate(REF));
    const dir = mkdtempSync(join(tmpdir(), "permdock-bundle-"));
    try {
      const flags = ["--policy", "../static-grants-inline/policy.ts"];
      const sqlOut = join(dir, "load.sql");
      const jsonOut = join(dir, "bundle.json");
      for (const [kind, out] of [
        ["sql", sqlOut],
        ["bundle", jsonOut],
      ] as const) {
        const result = await run(
          ["policy", "bundle", "--kind", kind, "--out", out, ...flags],
          { cwd: REF },
        );
        if (result.code !== 0) {
          throw new Error(`policy bundle: ${result.stdout}${result.stderr}`);
        }
      }
      loader = readFileSync(sqlOut, "utf8");
      bundle = readFileSync(jsonOut, "utf8");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    hash = /sha-256:[\w-]+/u.exec(loader)?.[0] ?? "";
    await createDatabase("inline", sql.get("inline") ?? "");
    await createDatabase("ref", sql.get("ref") ?? "");
    await admin("ref", loader);
    await createDatabase("unloaded", sql.get("ref") ?? "");
    await createDatabase("other", sql.get("ref") ?? "");
  }, 240_000);

  afterAll(async () => {
    await db?.stop();
  });

  it("leaves the static grants out of the generated SQL", () => {
    const ref = sql.get("ref") ?? "";
    expect(ref).toContain(hash);
    expect(ref).toContain("permdock_policy_bundle");
    expect(ref).not.toContain("('editor', 'doc.read'");
    expect(ref).not.toMatch(/insert into "permdock"."role_permissions"/u);
    expect(sql.get("inline")).toContain("('editor', 'doc.read'");
  });

  it("decides every user and action as the inline form does, and as getPermDock does", async () => {
    for (const user of USERS) {
      const inline = await outcome("inline", user);
      const ref = await outcome("ref", user);
      expect(ref).toStrictEqual(inline);
      const roles = [
        ["admin1", "o1", "admin"],
        ["editor1", "o1", "editor"],
        ["viewer1", "o1", "viewer"],
        ["admin2", "o2", "admin"],
      ] as const;
      const held = roles.find(([id]) => id === user);
      const permdock = await getPermDock(policy, {
        id: user,
        ...(held === undefined
          ? {}
          : {
              tenant: held[1],
              memberships: [
                { scope: "org", id: held[1], roles: [held[2]], via: "staff" },
              ],
            }),
      });
      for (const action of ["read", "update", "delete"] as const) {
        const expected = DOCS.filter((doc) =>
          permdock.can(permissions.doc[action], doc),
        ).map((doc) => doc.id);
        expect(ref[action]).toStrictEqual(expected);
      }
    }
    expect((await outcome("ref", "editor1")).delete).toStrictEqual([]);
    expect((await outcome("ref", "admin1")).delete).toStrictEqual(["d1", "d2"]);
  });

  it("denies every static grant when the bundle is not loaded", async () => {
    for (const user of USERS) {
      expect(await outcome("unloaded", user)).toStrictEqual({
        read: [],
        update: [],
        delete: [],
      });
    }
  });

  it("denies when only a bundle with another hash is loaded", async () => {
    const forged = JSON.stringify({
      format: "policy-bundle",
      v: 1,
      rows: [],
      roleKeys: {},
    });
    const digest = (
      await postgres().admin.query<{ readonly h: string }>(
        `select 'sha-256:' || translate(rtrim(encode(sha256(convert_to($1::text, 'UTF8')), 'base64'), '='), '+/', '-_') as h`,
        [forged],
      )
    ).rows[0]?.h;
    expect(digest).not.toBe(hash);
    await admin(
      "other",
      `insert into permdock.permdock_policy_bundle (hash, body) values ('${digest ?? ""}', '${forged}')`,
    );
    expect(await outcome("other", "admin1")).toStrictEqual({
      read: [],
      update: [],
      delete: [],
    });
  });

  it("refuses a body stored under a hash it does not have", async () => {
    await expect(
      admin(
        "other",
        `insert into permdock.permdock_policy_bundle (hash, body) values ('${hash}', '{"format":"policy-bundle","v":1,"rows":[],"roleKeys":{}}')`,
      ),
    ).rejects.toThrow(/permdock_policy_bundle_digest/u);
  });

  it("keeps the bundle and the view unreadable to the client roles", async () => {
    for (const relation of ["permdock_policy_bundle", "role_permissions"]) {
      await expect(
        asUser("ref", "admin1", `select 1 as id from permdock.${relation}`),
      ).rejects.toThrow(/permission denied/u);
    }
  });

  it("loads idempotently and the bundle text hashes to the pinned hash", async () => {
    await admin("ref", loader);
    const { rows } = await postgres().admin.query<{ readonly h: string }>(
      `select 'sha-256:' || translate(rtrim(encode(sha256(convert_to($1::text, 'UTF8')), 'base64'), '='), '+/', '-_') as h`,
      [bundle.trimEnd()],
    );
    expect(rows[0]?.h).toBe(hash);
  });
});
