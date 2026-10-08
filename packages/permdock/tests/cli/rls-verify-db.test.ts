import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import type { PermDockConfig } from "../../src/cli/types.ts";
import type { SqlCall, SqlReply } from "../fakes/sql.ts";

import { HELPER_TABLE_POLICIES_SQL } from "../../src/cli/helper-calls.ts";
import { runRlsVerify } from "../../src/cli/rls-verify.ts";
import { fakeSql } from "../fakes/sql.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "./fixtures/mini-app");
const TMP = join(HERE, "../../tmp");
const GRAPH = join(HERE, "../fixtures/graph.ts");
const QUICK_START = join(HERE, "../fixtures/quick-start.ts");

const temps: string[] = [];
const io = { stdout: () => undefined, stderr: () => undefined };

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const author = { id: "u1", roles: ["member"] };
const own = { id: "p1", authorId: "u1", orgId: "o1", published: false };
const other = { id: "p2", authorId: "u9", orgId: "o1", published: false };

function app(fixtures: unknown): string {
  mkdirSync(TMP, { recursive: true });
  const dir = mkdtempSync(join(TMP, "verify-db-"));
  temps.push(dir);
  cpSync(FIXTURE, dir, { recursive: true });
  writeFileSync(join(dir, "rls.fixtures.json"), JSON.stringify(fixtures));
  return dir;
}

function config(rls: PermDockConfig["rls"] = {}): PermDockConfig {
  return { policy: "./src/policy.ts", rls };
}

/** Answers the fixture statement (the one after `set_config`) with `rows` matched rows. */
function rowsFor(
  decide: (call: SqlCall) => number | string,
): (call: SqlCall) => SqlReply | undefined {
  return (call) => {
    if (!/^(select "id"|update|insert|delete)/u.test(call.sql)) {
      return undefined;
    }
    const answer = decide(call);
    return typeof answer === "string"
      ? { code: answer }
      : { rows: Array.from({ length: answer }, () => ({ id: "p1" })) };
  };
}

describe("rls verify --db through an injected client", () => {
  it("agrees when the database allows what decide grants and filters what it denies", async () => {
    const sql = fakeSql(rowsFor((call) => (call.values[0] === "p1" ? 1 : 0)));
    const cwd = app([
      { subject: author, row: own, action: "post.update", expected: "granted" },
      {
        subject: author,
        row: other,
        action: "post.update",
        expected: "denied",
      },
    ]);
    const outcome = await runRlsVerify({
      cwd,
      config: config(),
      db: "postgres://fake",
      format: "node",
      io,
      connect: sql.connect,
    });
    expect(outcome).toEqual({
      code: 0,
      output: "verified 2 fixture(s) in-process and against the database",
    });
    const statements = sql.statements();
    expect(statements[0]).toBe(HELPER_TABLE_POLICIES_SQL);
    expect(statements.filter((text) => text === "begin")).toHaveLength(2);
    expect(statements.filter((text) => text === "rollback")).toHaveLength(2);
    expect(statements).toContain('set local role "authenticated"');
    const claims = sql.calls.find(
      (call) => call.values[0] === "request.jwt.claims",
    );
    expect(JSON.parse(String(claims?.values[1]))).toMatchObject({
      sub: "u1",
      role: "authenticated",
      user_role: "member",
    });
    expect(
      statements.some((text) =>
        text.startsWith('update "post" set "id" = "id"'),
      ),
    ).toBe(true);
    expect(sql.ended()).toBe(true);
  });

  it("reports a mismatch per fixture the database answers differently", async () => {
    const sql = fakeSql(rowsFor(() => 1));
    const cwd = app([{ subject: author, row: other, action: "post.update" }]);
    const outcome = await runRlsVerify({
      cwd,
      config: config(),
      db: "postgres://fake",
      format: "node",
      io,
      connect: sql.connect,
    });
    expect(outcome).toEqual({
      code: 1,
      output: "post.update: in-process denied, database allowed",
    });
  });

  it("counts an insufficient_privilege error as a rejection of a denied write", async () => {
    const sql = fakeSql(rowsFor(() => "42501"));
    const cwd = app([
      {
        subject: author,
        row: other,
        newRow: { ...other, published: true },
        action: "post.update",
      },
      { subject: author, row: other, action: "post.delete" },
    ]);
    const outcome = await runRlsVerify({
      cwd,
      config: config(),
      db: "postgres://fake",
      format: "node",
      io,
      connect: sql.connect,
    });
    expect(outcome.code).toBe(0);
    const update = sql.calls.find((call) => call.sql.startsWith("update"));
    expect(update?.sql).toBe(
      'update "post" set "authorId" = $2, "orgId" = $3, "published" = $4 where "id" = $1 returning "id"',
    );
    expect(update?.values).toEqual(["p2", "u9", "o1", true]);
    expect(
      sql.statements().some((text) => text.startsWith('delete from "post"')),
    ).toBe(true);
  });

  it("inserts the whole row for a create fixture", async () => {
    const sql = fakeSql(rowsFor(() => 1));
    const cwd = app([{ subject: author, row: own, action: "post.create" }]);
    await runRlsVerify({
      cwd,
      config: config(),
      db: "postgres://fake",
      format: "node",
      io,
      connect: sql.connect,
    });
    const insert = sql.calls.find((call) => call.sql.startsWith("insert"));
    expect(insert?.sql).toBe(
      'insert into "post" ("id", "authorId", "orgId", "published") values ($1, $2, $3, $4) returning "id"',
    );
  });

  it("binds GUC settings under the configured prefix and claim names", async () => {
    const sql = fakeSql(rowsFor(() => 1));
    const cwd = app([
      {
        subject: { ...author, tenant: "o1" },
        row: own,
        action: "post.read",
      },
    ]);
    await runRlsVerify({
      cwd,
      config: config({
        dialect: "guc",
        gucPrefix: "acme",
        tenantClaim: "org",
        roleClaim: "roles",
        tables: { post: "posts" },
      }),
      db: "postgres://fake",
      format: "node",
      io,
      connect: sql.connect,
    });
    const settings = sql.calls
      .filter((call) => call.sql === "select set_config($1, $2, true)")
      .map((call) => call.values[0]);
    expect(settings).toEqual([
      "acme.user_id",
      "acme.roles",
      "acme.memberships",
      "acme.org",
    ]);
    expect(sql.statements()).toContain(
      'select "id" from "posts" where "id" = $1',
    );
  });

  it("flags a helper call in a storage policy that a row condition makes unsound (PD037)", async () => {
    const sql = fakeSql((call) =>
      call.sql === HELPER_TABLE_POLICIES_SQL
        ? {
            rows: [
              {
                target: "storage.objects",
                policyname: "own files",
                body: "permdock_has('post.update')",
              },
            ],
          }
        : rowsFor(() => 1)(call),
    );
    const cwd = app([{ subject: author, row: own, action: "post.update" }]);
    const outcome = await runRlsVerify({
      cwd,
      config: config(),
      db: "postgres://fake",
      format: "node",
      io,
      connect: sql.connect,
    });
    expect(outcome.code).toBe(1);
    expect(outcome.output).toMatch(/^PD037 /u);
  });

  it("falls back to the table when no field view exists, and compares the columns pick keeps", async () => {
    const sql = fakeSql((call) => {
      if (call.sql.startsWith('select * from "post_visible"')) {
        return { code: "42P01" };
      }
      if (call.sql.startsWith('select * from "post"')) {
        return { rows: [{ ...own, published: null }] };
      }
      return rowsFor(() => 1)(call);
    });
    const cwd = app([{ subject: author, row: own, action: "post.read" }]);
    const outcome = await runRlsVerify({
      cwd,
      config: config({ fields: "views" }),
      db: "postgres://fake",
      format: "node",
      io,
      connect: sql.connect,
    });
    expect(sql.statements()).toContain("rollback to savepoint permdock_fields");
    expect(outcome.code).toBe(1);
    expect(outcome.output).toBe(
      "post.read p1: field view returns [authorId, id, orgId], pick keeps [authorId, id, orgId, published]",
    );
  });

  it("queries a schema-qualified rls.tables entry and its field view by schema and name", async () => {
    const sql = fakeSql((call) => {
      if (call.sql.startsWith('select * from "app"."posts_visible"')) {
        return { rows: [own] };
      }
      return rowsFor(() => 1)(call);
    });
    const cwd = app([
      { subject: author, row: own, action: "post.read" },
      { subject: author, row: own, action: "post.update" },
    ]);
    const outcome = await runRlsVerify({
      cwd,
      config: config({ fields: "views", tables: { post: "app.posts" } }),
      db: "postgres://fake",
      format: "node",
      io,
      connect: sql.connect,
    });
    expect(outcome.code).toBe(0);
    expect(sql.statements()).toContain(
      'select "id" from "app"."posts" where "id" = $1',
    );
    expect(sql.statements()).toContain(
      'select * from "app"."posts_visible" where "id" = $1',
    );
    expect(
      sql
        .statements()
        .some((statement) => statement.startsWith('update "app"."posts" set')),
    ).toBe(true);
  });

  it("reports a field view that fails to read", async () => {
    const sql = fakeSql((call) =>
      call.sql.startsWith('select * from "post_visible"')
        ? { code: "42501" }
        : rowsFor(() => 1)(call),
    );
    const cwd = app([{ subject: author, row: own, action: "post.read" }]);
    const outcome = await runRlsVerify({
      cwd,
      config: config({ fields: "views" }),
      db: "postgres://fake",
      format: "node",
      io,
      connect: sql.connect,
    });
    expect(outcome.output).toContain("field view read failed (42501)");
  });

  it("seeds custom roles in database mode and stops when the seed is refused", async () => {
    const sql = fakeSql((call) =>
      call.sql.startsWith('insert into "permdock"."custom_role_permissions"')
        ? { code: "42501" }
        : rowsFor(() => 1)(call),
    );
    const cwd = app({
      customRoles: [
        {
          tenant: "o1",
          name: "reader",
          grants: [{ permission: "post.read" }],
          includes: ["member"],
        },
      ],
      fixtures: [
        {
          subject: {
            id: "u1",
            tenant: "o1",
            memberships: [{ tenant: "o1", roles: ["reader"] }],
          },
          row: own,
          action: "post.read",
        },
      ],
    });
    const outcome = await runRlsVerify({
      cwd,
      config: config({ customRoles: true, authorize: "database" }),
      db: "postgres://fake",
      format: "node",
      io,
      connect: sql.connect,
    });
    expect(outcome.code).toBe(2);
    expect(outcome.output).toContain("could not seed custom roles (42501)");
    expect(sql.statements().at(-1)).toBe("rollback");
    expect(sql.ended()).toBe(true);
  });

  it("seeds a custom role's level into the level column", async () => {
    const sql = fakeSql((call) =>
      call.sql.startsWith('insert into "permdock"."custom_role_permissions"')
        ? { code: "42501" }
        : rowsFor(() => 1)(call),
    );
    const cwd = app({
      customRoles: [
        {
          tenant: "o1",
          name: "reader",
          grants: [{ permission: "post.read", level: "own" }],
        },
      ],
      fixtures: [
        {
          subject: {
            id: "u1",
            tenant: "o1",
            memberships: [{ tenant: "o1", roles: ["reader"] }],
          },
          row: own,
          action: "post.read",
        },
      ],
    });
    const outcome = await runRlsVerify({
      cwd,
      config: config({ customRoles: true, authorize: "database" }),
      db: "postgres://fake",
      format: "node",
      io,
      connect: sql.connect,
    });
    expect(outcome.code).toBe(2);
    expect(
      sql
        .statements()
        .some((statement) =>
          statement.includes(
            "effect, level) values ($1, $2, $3, $4, $5, $6, $7)",
          ),
        ),
    ).toBe(true);
  });

  it("turns a connection failure into exit code 2", async () => {
    const cwd = app([{ subject: author, row: own, action: "post.read" }]);
    const outcome = await runRlsVerify({
      cwd,
      config: config(),
      db: "postgres://fake",
      format: "node",
      io,
      connect: () =>
        Promise.reject(
          new Error("PermDock CLI: rls verify --db could not connect"),
        ),
    });
    expect(outcome).toEqual({
      code: 2,
      output: "PermDock CLI: rls verify --db could not connect",
    });
  });

  it("skips the database for an unknown permission and reports it", async () => {
    const sql = fakeSql();
    const cwd = app([{ subject: author, row: own, action: "post.nope" }]);
    const outcome = await runRlsVerify({
      cwd,
      config: config(),
      db: "postgres://fake",
      format: "node",
      io,
      connect: sql.connect,
    });
    expect(outcome).toEqual({
      code: 1,
      output: "post.nope: unknown permission",
    });
    expect(sql.statements()).toEqual([HELPER_TABLE_POLICIES_SQL]);
  });
});

describe("rls verify fixtures", () => {
  it.each([
    [{ nope: true }, "fixtures must be an array or { fixtures }"],
    [[{ subject: author }], "fixture 0 needs subject and row"],
    [[{ subject: author, row: own }], "fixture 0 needs action"],
    [[{ subject: {}, row: own, action: "post.read" }], "subject needs id"],
    [
      [
        {
          subject: { id: "u1", memberships: {} },
          row: own,
          action: "post.read",
        },
      ],
      "subject.memberships must be an array",
    ],
    [
      [{ subject: { id: "u1", tenant: 1 }, row: own, action: "post.read" }],
      "subject.tenant must be a string",
    ],
    [
      [{ subject: { id: "u1", claims: "x" }, row: own, action: "post.read" }],
      "subject.claims must be an object",
    ],
    [
      { customRoles: {}, fixtures: [] },
      "fixtures customRoles must be an array",
    ],
  ])("rejects %j", async (fixtures, message) => {
    const cwd = app(fixtures);
    await expect(
      runRlsVerify({ cwd, config: config(), format: "node", io }),
    ).rejects.toThrow(message);
  });

  it("needs a policy and an existing fixtures file", async () => {
    const cwd = app([]);
    expect(
      await runRlsVerify({ cwd, config: {}, format: "node", io }),
    ).toMatchObject({ code: 2 });
    await expect(
      runRlsVerify({
        cwd,
        config: config({ fixtures: "missing.json" }),
        format: "node",
        io,
      }),
    ).rejects.toThrow("fixtures not found: missing.json");
  });

  it("loads fixtures from a module export", async () => {
    const cwd = app([]);
    writeFileSync(
      join(cwd, "rls.fixtures.mjs"),
      `export const fixtures = ${JSON.stringify([
        { subject: author, row: own, action: "post.read", expected: "denied" },
      ])};`,
    );
    const outcome = await runRlsVerify({
      cwd,
      config: config(),
      fixtures: "rls.fixtures.mjs",
      format: "node",
      io,
    });
    expect(outcome).toEqual({
      code: 1,
      output: "post.read: in-process granted, expected denied",
    });
  });
});

describe("rls verify --tree through an injected client", () => {
  it("needs --db", async () => {
    const cwd = app([]);
    expect(
      await runRlsVerify({
        cwd,
        config: config(),
        tree: true,
        format: "node",
        io,
      }),
    ).toEqual({
      code: 2,
      output: "PermDock CLI: rls verify --tree needs --db",
    });
  });

  it("passes with a note when no grant walks a tree", async () => {
    const sql = fakeSql();
    const outcome = await runRlsVerify({
      cwd: HERE,
      config: {},
      from: QUICK_START,
      tree: true,
      db: "postgres://fake",
      format: "node",
      io,
      connect: sql.connect,
    });
    expect(outcome).toEqual({
      code: 0,
      output:
        "verified 0 tree check(s) against the database (0 granted)\nno graph grant walks a self-parented resource",
    });
    expect(sql.statements()).toEqual(["begin", "rollback"]);
    expect(sql.ended()).toBe(true);
  });

  it("reports the rows the database shows but decide denies", async () => {
    const sql = fakeSql((call) => {
      if (call.sql.startsWith("insert")) {
        return { rows: [] };
      }
      return undefined;
    });
    const outcome = await runRlsVerify({
      cwd: HERE,
      config: {},
      from: GRAPH,
      tree: true,
      db: "postgres://fake",
      format: "node",
      io,
      connect: sql.connect,
    });
    expect(outcome.code).toBe(0);
    expect(outcome.output).toMatch(/^verified 0 tree check/u);
  });

  it("explains a seed failure as exit code 2", async () => {
    const sql = fakeSql((call) =>
      call.sql.startsWith("insert") ? { code: "42501" } : undefined,
    );
    const outcome = await runRlsVerify({
      cwd: HERE,
      config: {},
      from: GRAPH,
      tree: true,
      db: "postgres://fake",
      format: "node",
      io,
      connect: sql.connect,
    });
    expect(outcome.code).toBe(2);
    expect(outcome.output).toContain(
      "rls verify --tree could not seed the tree (SQLSTATE 42501)",
    );
    expect(sql.statements().at(-1)).toBe("rollback");
  });
});
