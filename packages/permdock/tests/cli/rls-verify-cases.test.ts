import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { SqlClient } from "../../src/cli/pg.ts";
import type { PermDockConfig } from "../../src/cli/types.ts";
import type { SqlCall, SqlReply } from "../fakes/sql.ts";

import { runRlsVerify } from "../../src/cli/rls-verify.ts";
import { fakeSql } from "../fakes/sql.ts";

const FIXTURE = path.join(import.meta.dirname, "fixtures/mini-app");
const TMP = path.join(import.meta.dirname, "../../tmp");
const temps: string[] = [];
const io = { stdout: () => undefined, stderr: () => undefined };

afterAll(() => {
  for (const dir of temps) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const POLICY = `import { allow, definePolicy, opaque, principal, role, sqlFunction } from 'permdock';
import { permissions } from './permissions.ts';

const member = role('member', [
  allow(permissions.post.read, {
    where: sqlFunction('post_visible', {
      args: [{ field: 'id' }],
      twin: { authorId: principal.id },
    }),
  }),
  allow(permissions.post.update, { where: opaque({ sql: 'ok(id)', fingerprint: 'x' }) }),
  allow(permissions.post.publish),
  allow(permissions.post.create),
]);

export const policy = definePolicy(permissions, {
  roles: [member],
  subject: () => null,
});
`;

function app(fixtures: unknown): string {
  mkdirSync(TMP, { recursive: true });
  const dir = mkdtempSync(path.join(TMP, "rls-verify-cases-"));
  temps.push(dir);
  cpSync(FIXTURE, dir, { recursive: true });
  writeFileSync(path.join(dir, "src/cases-policy.ts"), POLICY);
  writeFileSync(path.join(dir, "rls.fixtures.json"), JSON.stringify(fixtures));
  return dir;
}

function config(rls: PermDockConfig["rls"] = {}): PermDockConfig {
  return { policy: "./src/cases-policy.ts", rls };
}

const author = { id: "u1", roles: ["member"] };
const own = { id: "p1", authorId: "u1", orgId: "o1", published: false };
const other = { id: "p2", authorId: "u9", orgId: "o1", published: false };

function rowsFor(
  decide: (call: SqlCall) => number,
): (call: SqlCall) => SqlReply | undefined {
  return (call) =>
    /^(select "id"|update|insert|delete)/u.test(call.sql)
      ? { rows: Array.from({ length: decide(call) }, () => ({ id: "p1" })) }
      : undefined;
}

describe("rls verify --format pgtap", () => {
  it("asserts the in-process outcome of each fixture against the database", async () => {
    const cwd = app([
      { subject: { id: "u1" }, row: own, action: "post.read" },
      { subject: author, row: own, action: "post.publish" },
      { subject: author, row: own, action: "post.update" },
      {
        subject: author,
        row: { id: "p'3", authorId: "u1", orgId: "o1", published: false },
        action: "post.create",
      },
    ]);
    const outcome = await runRlsVerify({
      cwd,
      config: config(),
      format: "pgtap",
      io,
    });
    expect(outcome.code).toBe(0);
    const lines = outcome.output.split("\n");
    expect(lines.slice(0, 3)).toEqual([
      "begin;",
      "select plan(4);",
      "create function pg_temp.permdock_decision(statement text) returns text",
    ]);
    expect(lines).toContain(
      `select set_config('request.jwt.claims', '{"sub":"u1","role":"authenticated","user_role":[],"memberships":[]}', true);`,
    );
    expect(lines).toContain(
      `select is(pg_temp.permdock_decision('select "id" from "post" where "id" = ''p1'''), 'denied', 'fixture 0 post.read denied');`,
    );
    expect(lines).toContain(
      `select is(pg_temp.permdock_decision('select "id" from "post" where "id" = ''p1'''), 'granted', 'fixture 1 post.publish granted');`,
    );
    expect(lines).toContain(
      "select skip('fixture 2 post.update: opaque grant untestable app-side', 1);",
    );
    expect(lines).toContain(
      `select is(pg_temp.permdock_decision('insert into "post" ("id", "authorId", "orgId", "published") values (''p''''3'', ''u1'', ''o1'', ''false'') returning "id"'), 'granted', 'fixture 3 post.create granted');`,
    );
    expect(
      lines.filter((line) => line === "savepoint permdock_fixture;"),
    ).toHaveLength(3);
    expect(lines.slice(-3)).toEqual([
      "select * from finish();",
      "rollback;",
      "",
    ]);
  });

  it("binds the guc settings and seeds custom roles without replacing existing rows", async () => {
    const cwd = app({
      fixtures: [
        {
          subject: {
            id: "u1",
            tenant: "o1",
            memberships: [{ tenant: "o1", roles: ["editor"] }],
          },
          row: own,
          action: "post.publish",
        },
      ],
      customRoles: [
        {
          name: "editor",
          tenant: "o1",
          grants: [{ permission: "post.publish" }],
          includes: ["member"],
        },
      ],
    });
    const outcome = await runRlsVerify({
      cwd,
      config: config({
        dialect: "guc",
        customRoles: true,
        authorize: "database",
      }),
      format: "pgtap",
      io,
    });
    expect(outcome.code).toBe(0);
    expect(outcome.output).toContain(
      `insert into "permdock"."custom_role_permissions" (tenant_id, scope, scope_id, role, permission, effect) values ('o1', 'tenant', null, 'editor', 'post.publish', 'allow') on conflict do nothing;`,
    );
    expect(outcome.output).toContain(
      `insert into "permdock"."custom_role_includes" (tenant_id, scope, scope_id, role, include_role) values ('o1', 'tenant', null, 'editor', 'member') on conflict do nothing;`,
    );
    expect(outcome.output).toContain(
      "select set_config('app.user_id', 'u1', true);",
    );
    expect(outcome.output).toContain(
      "select set_config('app.tenant_id', 'o1', true);",
    );
  });

  it("refuses to write a script when a fixture disagrees with can()", async () => {
    const cwd = app([
      { subject: author, row: own, action: "post.publish", expected: "denied" },
      { subject: author, row: own, action: "post.nope" },
    ]);
    const outcome = await runRlsVerify({
      cwd,
      config: config(),
      format: "pgtap",
      io,
    });
    expect(outcome).toEqual({
      code: 1,
      output:
        "post.publish: in-process granted, expected denied\npost.nope: unknown permission",
    });
  });
});

describe("rls verify --db grant kinds and statements", () => {
  it("verifies a sqlFunction through its twin, skips an opaque grant and runs custom actions as a select", async () => {
    const sql = fakeSql(rowsFor((call) => (call.values[0] === "p1" ? 1 : 0)));
    const cwd = app([
      { subject: author, row: own, action: "post.read" },
      { subject: author, row: other, action: "post.read" },
      { subject: author, row: own, action: "post.update" },
      { subject: author, row: own, action: "post.publish" },
      { subject: author, row: { nested: { id: "p1" } }, action: "post.create" },
    ]);
    const outcome = await runRlsVerify({
      cwd,
      config: config(),
      db: "postgres://fake",
      format: "node",
      io,
      connect: sql.connect,
    });
    expect(outcome.output).toBe(
      [
        "verified 5 fixture(s) in-process and against the database",
        "post.update: opaque grant untestable app-side",
        "post.read: verified through twin",
        "post.read: verified through twin",
        "post.update: opaque grant untestable app-side",
      ].join("\n"),
    );
    const statements = sql.statements();
    expect(statements).toContain(
      'insert into "post" ("id") values ($1) returning "id"',
    );
    expect(
      statements.filter(
        (text) => text === 'select "id" from "post" where "id" = $1',
      ),
    ).toHaveLength(3);
  });

  it("reads rowCount from the rows and a throw without a code as filtered", async () => {
    const client: SqlClient = {
      query: async (text) => {
        if (text.startsWith("update")) {
          throw new Error("no code");
        }
        return text.startsWith('select "id"')
          ? { rows: [{ id: "p1" }], rowCount: null }
          : { rows: [] };
      },
      end: async () => undefined,
    };
    const cwd = app([
      { subject: author, row: own, action: "post.publish" },
      {
        subject: { id: "u2" },
        row: own,
        newRow: { ...own, published: true },
        action: "post.update",
      },
    ]);
    const outcome = await runRlsVerify({
      cwd,
      config: config(),
      db: "postgres://fake",
      format: "node",
      io,
      connect: async () => client,
    });
    expect(outcome).toEqual({
      code: 0,
      output:
        "verified 2 fixture(s) in-process and against the database\npost.update: opaque grant untestable app-side\npost.update: opaque grant untestable app-side",
    });
  });

  it("turns an unsafe table name and a thrown string into exit code 2", async () => {
    const cwd = app([{ subject: author, row: own, action: "post.publish" }]);
    const unsafe = await runRlsVerify({
      cwd,
      config: config({ tables: { post: "post; drop" } }),
      db: "postgres://fake",
      format: "node",
      io,
      connect: fakeSql().connect,
    });
    expect(unsafe).toEqual({
      code: 2,
      output: "PermDock CLI: unsafe SQL identifier 'post; drop'",
    });
    const thrown = await runRlsVerify({
      cwd,
      config: config(),
      db: "postgres://fake",
      format: "node",
      io,
      connect: async () => {
        const refused: unknown = "refused";
        throw refused;
      },
    });
    expect(thrown).toEqual({ code: 2, output: "refused" });
  });
});

describe("rls verify --db field views", () => {
  it("passes when the view keeps what pick keeps, and a denied row reads nothing", async () => {
    const sql = fakeSql((call) => {
      if (call.sql.startsWith('select * from "post_visible"')) {
        return { rows: call.values[0] === "p1" ? [own] : [] };
      }
      return rowsFor((statement) => (statement.values[0] === "p1" ? 1 : 0))(
        call,
      );
    });
    const cwd = app([
      { subject: author, row: own, action: "post.read" },
      { subject: author, row: other, action: "post.read" },
    ]);
    const outcome = await runRlsVerify({
      cwd,
      config: config({ fields: "views" }),
      db: "postgres://fake",
      format: "node",
      io,
      connect: sql.connect,
    });
    expect(outcome).toEqual({
      code: 0,
      output:
        "verified 2 fixture(s) in-process and against the database\npost.read: verified through twin\npost.read: verified through twin",
    });
  });
});

describe("rls verify --db custom role seeds", () => {
  it("seeds pinned, team and unknown-scope roles into the rbac schema", async () => {
    const sql = fakeSql(rowsFor(() => 1));
    const cwd = app({
      customRoles: [
        {
          tenant: "o1",
          name: "pinned",
          scope: "tenant",
          id: "o1",
          grants: [{ permission: "post.read", effect: "deny" }],
        },
        { tenant: "o1", name: "teamed", team: "t1", includes: ["member"] },
        {
          tenant: "o1",
          name: "plain",
          grants: [{ permission: "post.publish" }],
        },
        {
          tenant: "o1",
          name: "nowhere",
          scope: "region",
          grants: [{ permission: "post.read" }],
        },
      ],
      fixtures: [
        {
          subject: { id: "u1", tenant: "o1" },
          row: own,
          action: "post.publish",
        },
      ],
    });
    const outcome = await runRlsVerify({
      cwd,
      config: config({
        customRoles: true,
        rbac: { authorize: "database", schema: "authz" },
      }),
      db: "postgres://fake",
      format: "node",
      io,
      connect: sql.connect,
    });
    expect(outcome.code).toBe(1);
    const seeds = sql.calls.filter((call) =>
      call.sql.startsWith('insert into "authz"'),
    );
    expect(seeds.map((call) => call.values)).toEqual([
      ["o1", "tenant", "o1", "pinned", "post.read", "deny"],
      ["o1", "team", "t1", "teamed", "member"],
      ["o1", "tenant", null, "plain", "post.publish", "allow"],
    ]);
  });
});

describe("rls verify --tree failures", () => {
  it("reports a thrown string from the seed and ignores a failed rollback", async () => {
    let ended = false;
    const client: SqlClient = {
      query: async (text) => {
        if (text === "begin") {
          return { rows: [] };
        }
        const gone: unknown = "gone";
        throw gone;
      },
      end: async () => {
        ended = true;
      },
    };
    const outcome = await runRlsVerify({
      cwd: import.meta.dirname,
      config: {},
      from: path.join(import.meta.dirname, "../fixtures/graph.ts"),
      tree: true,
      db: "postgres://fake",
      format: "node",
      io,
      connect: async () => client,
    });
    expect(outcome.code).toBe(2);
    expect(outcome.output).toContain("could not seed the tree (gone)");
    expect(ended).toBe(true);
  });

  it("turns a connection failure into exit code 2", async () => {
    const cwd = app([]);
    const failed = (cause: unknown) =>
      runRlsVerify({
        cwd,
        config: config(),
        tree: true,
        db: "postgres://fake",
        format: "node",
        io,
        connect: async () => {
          throw cause;
        },
      });
    expect(await failed(new Error("no route"))).toEqual({
      code: 2,
      output: "no route",
    });
    expect(await failed("refused")).toEqual({ code: 2, output: "refused" });
  });

  it("exits 1 with the rows the database shows but decide denies", async () => {
    const sql = fakeSql((call) => {
      if (call.sql.startsWith("insert into ")) {
        return {
          rows:
            call.values.length > 0
              ? [{ id: "f1", parentId: null, restricted: false }]
              : [],
        };
      }
      if (call.sql.includes(" = any($1)")) {
        const ids = Array.isArray(call.values[0]) ? call.values[0] : [];
        return { rows: ids.map((id: unknown) => ({ id })) };
      }
      return undefined;
    });
    const outcome = await runRlsVerify({
      cwd: import.meta.dirname,
      config: {},
      from: path.join(import.meta.dirname, "../fixtures/graph.ts"),
      tree: true,
      db: "postgres://fake",
      format: "node",
      io,
      connect: sql.connect,
    });
    expect(outcome.code).toBe(1);
    expect(outcome.output).toMatch(/: in-process denied, database allowed$/mu);
  });
});
