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
  it("writes one ok per fixture with a null tenant and no memberships", async () => {
    const cwd = app([{ subject: { id: "u1" }, row: own, action: "post.read" }]);
    const outcome = await runRlsVerify({
      cwd,
      config: config(),
      format: "pgtap",
      io,
    });
    expect(outcome.code).toBe(0);
    expect(outcome.output).toContain("select plan(1);");
    expect(outcome.output).toContain(
      String.raw`\"tenant_id\":null,\"memberships\":[]`,
    );
    expect(outcome.output).toContain("select ok(true, 'fixture 0 post.read');");
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
        "verified 5 fixture(s) in-process",
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
        "verified 2 fixture(s) in-process\npost.update: opaque grant untestable app-side\npost.update: opaque grant untestable app-side",
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
        "verified 2 fixture(s) in-process\npost.read: verified through twin\npost.read: verified through twin",
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
