import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "permdock/cli";
import { rlsParity, type RlsParityFixture } from "permdock/testing";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Postgres } from "./support/postgres.ts";

import { permissions } from "../fixtures/rls-fields/permissions.ts";
import { policy } from "../fixtures/rls-fields/policy.ts";
import { startPostgres } from "./support/postgres.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "../fixtures/rls-fields");

const ADMIN = "00000000-0000-4000-8000-0000000000a1";
const FINANCE = "00000000-0000-4000-8000-0000000000b2";
const MEMBER = "00000000-0000-4000-8000-0000000000c3";
const AUDITOR = "00000000-0000-4000-8000-0000000000d4";
const OUTSIDER = "00000000-0000-4000-8000-0000000000e5";
const STRANGER = "00000000-0000-4000-8000-0000000000f6";

type Dialect = "supabase" | "neon" | "guc";

const ROLES = `
create role authenticated nologin;
create role anon nologin;
create role anonymous nologin;
grant authenticated, anon, anonymous to tester;
`;

const CLAIMS = `coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb`;

// The auth functions each dialect's generated SQL calls; `guc` reads settings directly.
const STUBS: Readonly<Record<Dialect, string>> = {
  supabase: `
create schema auth;
create function auth.jwt() returns jsonb language sql stable as $$ select ${CLAIMS} $$;
create function auth.uid() returns uuid language sql stable as $$ select nullif(auth.jwt() ->> 'sub', '')::uuid $$;
grant usage on schema auth to authenticated, anon;
grant execute on all functions in schema auth to authenticated, anon;
`,
  neon: `
create schema auth;
create function auth.session() returns jsonb language sql stable as $$ select ${CLAIMS} $$;
create function auth.user_id() returns text language sql stable as $$ select nullif(auth.session() ->> 'sub', '') $$;
grant usage on schema auth to authenticated, anonymous;
grant execute on all functions in schema auth to authenticated, anonymous;
`,
  guc: "",
};

const ROWS = [
  {
    id: "i-own",
    orgId: "acme",
    authorId: MEMBER,
    title: "Own",
    amount: 100,
    note: "own note",
  },
  {
    id: "i-other",
    orgId: "acme",
    authorId: ADMIN,
    title: "Other",
    amount: 200,
    note: "other note",
  },
  {
    id: "i-globex",
    orgId: "globex",
    authorId: OUTSIDER,
    title: "Globex",
    amount: 300,
    note: "globex note",
  },
  {
    id: "i-public",
    orgId: "public",
    authorId: ADMIN,
    title: "Public",
    amount: 400,
    note: "public note",
  },
] as const;

function tableSql(dialect: Dialect): string {
  const author = dialect === "supabase" ? "uuid" : "text";
  const values = ROWS.map(
    (row) =>
      `('${row.id}', '${row.orgId}', '${row.authorId}', '${row.title}', ${String(row.amount)}, '${row.note}')`,
  ).join(",\n  ");
  return `
grant usage on schema public to authenticated, anon, anonymous;
create table public.invoice (
  id text primary key,
  "orgId" text not null,
  "authorId" ${author} not null,
  title text not null,
  amount integer not null,
  note text not null
);
insert into public.invoice values
  ${values};
`;
}

type Subject = {
  readonly id: string;
  readonly roles?: readonly string[];
  readonly tenant?: string;
  readonly memberships?: readonly {
    readonly tenant: string;
    readonly roles: readonly string[];
  }[];
};

function member(id: string, tenant: string, role: string): Subject {
  return { id, tenant, memberships: [{ tenant, roles: [role] }] };
}

const SUBJECTS: Readonly<Record<string, Subject>> = {
  admin: member(ADMIN, "acme", "admin"),
  finance: member(FINANCE, "acme", "finance"),
  member: member(MEMBER, "acme", "member"),
  outsider: member(OUTSIDER, "globex", "member"),
  auditor: { id: AUDITOR, roles: ["auditor"] },
  stranger: { id: STRANGER },
};

// Columns with a value in `invoice_visible`, pinned to intent so a view that
// hides (or shows) everything cannot pass by agreeing with itself.
const EXPECTED: Readonly<Record<string, readonly string[]>> = {
  "admin i-other": ["amount", "authorId", "id", "note", "orgId", "title"],
  "finance i-other": ["amount", "id", "orgId", "title"],
  "member i-own": ["amount", "authorId", "id", "note", "orgId", "title"],
  "member i-other": ["authorId", "id", "orgId", "title"],
  "auditor i-globex": ["amount", "authorId", "id", "orgId", "title"],
  "outsider i-other": [],
  "stranger i-public": ["id", "title"],
  "finance i-public": ["id", "title"],
};

type Shape = { readonly dialect: Dialect; readonly revoke: boolean };

const SHAPES: readonly Shape[] = (["supabase", "neon", "guc"] as const).flatMap(
  (dialect) => [
    { dialect, revoke: false },
    { dialect, revoke: true },
  ],
);

function shapeName(shape: Shape): string {
  return `fields_${shape.dialect}${shape.revoke ? "_revoke" : ""}`;
}

function databaseUri(uri: string, database: string): string {
  const url = new URL(uri);
  url.pathname = `/${database}`;
  return url.toString();
}

function testerUri(uri: string, database: string): string {
  const url = new URL(databaseUri(uri, database));
  url.username = "tester";
  url.password = "tester";
  return url.toString();
}

function configFor(shape: Shape): string {
  const rls = {
    dialect: shape.dialect,
    tenantType: "text",
    fields: "views",
    revokeColumns: shape.revoke,
  };
  return `export default ${JSON.stringify(
    {
      permissions: join(FIXTURE, "permissions.ts"),
      policy: join(FIXTURE, "policy.ts"),
      rls,
    },
    null,
    2,
  )};\n`;
}

function verifyFixtures(): readonly unknown[] {
  const reads = Object.entries(SUBJECTS).flatMap(([, subject]) =>
    ROWS.map((row) => ({ subject, row, action: "invoice.read" })),
  );
  return [
    ...reads,
    {
      subject: SUBJECTS["admin"],
      row: ROWS[1],
      newRow: { ...ROWS[1], title: "Renamed" },
      action: "invoice.update",
      expected: "granted",
    },
    {
      subject: SUBJECTS["finance"],
      row: ROWS[1],
      newRow: { ...ROWS[1], title: "Renamed" },
      action: "invoice.update",
      expected: "denied",
    },
  ];
}

function parityFixtures(): readonly RlsParityFixture[] {
  return Object.entries(SUBJECTS).flatMap(([name, subject]) =>
    ROWS.map((row) => ({
      name: `${name} ${row.id}`,
      subject,
      permission: permissions.invoice.read,
      row,
      table: "invoice",
    })),
  );
}

type Session = {
  readonly client: Client;
  readonly query: (
    sql: string,
    values?: readonly unknown[],
  ) => Promise<{
    readonly rows: readonly Record<string, unknown>[];
    readonly rowCount?: number;
    readonly code?: string;
  }>;
};

function session(client: Client): Session {
  return {
    client,
    async query(sql, values) {
      expect(sql).not.toMatch(/service_role/i);
      try {
        const result = await client.query(
          sql,
          values === undefined ? undefined : [...values],
        );
        return { rows: result.rows, rowCount: result.rowCount ?? 0 };
      } catch (error) {
        const code =
          error !== null &&
          typeof error === "object" &&
          "code" in error &&
          typeof error.code === "string"
            ? error.code
            : undefined;
        return code === undefined ? { rows: [] } : { rows: [], code };
      }
    },
  };
}

function valued(row: Readonly<Record<string, unknown>> | undefined): string[] {
  return Object.entries(row ?? {})
    .filter(([, value]) => value !== null)
    .map(([name]) => name)
    .toSorted();
}

async function asRole<T>(
  s: Session,
  role: "authenticated" | "anon" | "anonymous",
  settings: Readonly<Record<string, string>>,
  work: () => Promise<T>,
): Promise<T> {
  await s.query("begin");
  try {
    await s.query(`set local role ${role}`);
    for (const [name, value] of Object.entries(settings)) {
      await s.query("select set_config($1, $2, true)", [name, value]);
    }
    return await work();
  } finally {
    await s.query("rollback");
  }
}

function financeSettings(dialect: Dialect): Readonly<Record<string, string>> {
  const memberships = JSON.stringify([
    { scope: "tenant", id: "acme", roles: ["finance"] },
  ]);
  return dialect === "guc"
    ? { "app.user_id": FINANCE, "app.memberships": memberships }
    : {
        "request.jwt.claims": JSON.stringify({
          sub: FINANCE,
          role: "authenticated",
          // SAFETY: parses the memberships JSON built above; the value is only re-serialized
          memberships: JSON.parse(memberships) as unknown,
        }),
      };
}

describe("rls generate --fields views (supabase, neon, guc)", () => {
  let db: Postgres | undefined;
  const dir = mkdtempSync(join(tmpdir(), "permdock-fields-"));
  const fixturesPath = join(dir, "rls.fixtures.json");
  const clients = new Map<string, Session>();

  beforeAll(async () => {
    writeFileSync(
      fixturesPath,
      `${JSON.stringify(verifyFixtures(), null, 2)}\n`,
    );
    db = await startPostgres([ROLES]);
    for (const shape of SHAPES) {
      const name = shapeName(shape);
      const cwd = join(dir, name);
      const out = join(cwd, "rls.sql");
      mkdirSync(cwd);
      writeFileSync(join(cwd, "permdock.config.ts"), configFor(shape));
      const generated = await run(
        [
          "rls",
          "generate",
          "--target",
          "sql",
          "--dialect",
          shape.dialect,
          "--out",
          out,
        ],
        { cwd },
      );
      if (generated.code !== 0) {
        throw new Error(`rls generate ${name}: ${generated.stdout}`);
      }
      await db.admin.query(`create database ${name}`);
      const admin = new Client({
        connectionString: databaseUri(db.uri, name),
      });
      await admin.connect();
      try {
        await admin.query(
          [
            STUBS[shape.dialect],
            tableSql(shape.dialect),
            readFileSync(out, "utf8"),
          ].join("\n"),
        );
      } catch (cause) {
        throw new Error(`apply ${name}`, { cause });
      } finally {
        await admin.end();
      }
      const tester = new Client({
        connectionString: testerUri(db.uri, name),
      });
      await tester.connect();
      clients.set(name, session(tester));
    }
  }, 240_000);

  afterAll(async () => {
    for (const s of clients.values()) {
      await s.client.end();
    }
    rmSync(dir, { recursive: true, force: true });
    await db?.stop();
  });

  it.each(SHAPES)(
    "$dialect revoke=$revoke: rls verify checks every row and column against pick",
    async (shape) => {
      if (db === undefined) {
        throw new Error("PermDock: Postgres was not started");
      }
      const name = shapeName(shape);
      const result = await run(
        [
          "rls",
          "verify",
          "--db",
          testerUri(db.uri, name),
          "--fixtures",
          fixturesPath,
        ],
        { cwd: join(dir, name) },
      );
      expect(result.stdout).toContain(
        `verified ${String(verifyFixtures().length)} fixture(s)`,
      );
      expect(result.code).toBe(0);
    },
  );

  it.each(SHAPES)(
    "$dialect revoke=$revoke: the view returns exactly the columns pick keeps",
    async (shape) => {
      const s = clients.get(shapeName(shape));
      if (s === undefined) {
        throw new Error("PermDock: database missing");
      }
      const report = await rlsParity(policy, {
        dialect: shape.dialect,
        fieldViews: true,
        fixtures: parityFixtures(),
        query: s.query,
      });
      const failed = report.results.filter((item) => !item.ok);
      expect(failed).toEqual([]);
      for (const item of report.results) {
        const expected = EXPECTED[item.name];
        if (expected !== undefined) {
          expect({ name: item.name, columns: item.fields?.database }).toEqual({
            name: item.name,
            columns: expected,
          });
        }
      }
    },
  );

  it.each(SHAPES)(
    "$dialect revoke=$revoke: anon reads the public row through the view, id and title only",
    async (shape) => {
      const s = clients.get(shapeName(shape));
      if (s === undefined) {
        throw new Error("PermDock: database missing");
      }
      const rows = await asRole(
        s,
        shape.dialect === "neon" ? "anonymous" : "anon",
        {},
        async () => s.query("select * from invoice_visible order by id"),
      );
      expect(rows.code).toBeUndefined();
      expect(rows.rows.map((row) => row["id"])).toEqual(["i-public"]);
      expect(valued(rows.rows[0])).toEqual(["id", "title"]);
    },
  );

  it.each(SHAPES)(
    "$dialect revoke=$revoke: the base table closes restricted columns only with --revoke-columns",
    async (shape) => {
      const s = clients.get(shapeName(shape));
      if (s === undefined) {
        throw new Error("PermDock: database missing");
      }
      const settings = financeSettings(shape.dialect);
      const direct = await asRole(s, "authenticated", settings, async () =>
        s.query(`select note from invoice where id = 'i-other'`),
      );
      const open = await asRole(s, "authenticated", settings, async () =>
        s.query(`select id, title from invoice where id = 'i-other'`),
      );
      const all = await asRole(s, "authenticated", settings, async () =>
        s.query(`select * from invoice_visible order by id`),
      );
      expect(open.rows).toEqual([{ id: "i-other", title: "Other" }]);
      expect(
        all.rows.map((row) => [row["id"], row["amount"], row["note"]]),
      ).toEqual([
        ["i-other", 200, null],
        ["i-own", 100, null],
        ["i-public", null, null],
      ]);
      if (shape.revoke) {
        expect(direct.code).toBe("42501");
      } else {
        expect(direct.rows).toEqual([{ note: "other note" }]);
      }
    },
  );

  it("reads the generated view back with rls import --db", async () => {
    if (db === undefined) {
      throw new Error("PermDock: Postgres was not started");
    }
    for (const shape of SHAPES.filter((item) => item.dialect === "supabase")) {
      const name = shapeName(shape);
      const out = join(dir, `${name}.generated.ts`);
      const imported = await run(
        ["rls", "import", "--db", databaseUri(db.uri, name), "--out", out],
        { cwd: join(dir, name) },
      );
      expect(imported.code).toBe(0);
      const text = readFileSync(out, "utf8");
      const json = /export const fieldViews = ([\s\S]*?) as const/u.exec(
        text,
      )?.[1];
      // SAFETY: the generated fieldViews literal is JSON in this shape
      const views = JSON.parse(json ?? "[]") as readonly {
        readonly view: string;
        readonly table: string;
        readonly companion?: string;
        readonly passthrough: readonly string[];
        readonly restricted: readonly {
          readonly column: string;
          readonly grants: readonly { readonly permission: string }[];
        }[];
      }[];
      expect(views.map((view) => view.view)).toEqual(["invoice_visible"]);
      expect(views[0]?.passthrough).toEqual(["id", "title"]);
      expect(views[0]?.restricted.map((item) => item.column)).toEqual([
        "orgId",
        "authorId",
        "amount",
        "note",
      ]);
      expect(views[0]?.companion).toBe(
        shape.revoke ? "invoice_visible_fields" : undefined,
      );
    }
  });
});
