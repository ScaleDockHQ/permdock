import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "permdock/cli";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Postgres } from "./support/postgres.ts";

import { startPostgres } from "./support/postgres.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "../fixtures/schema-tables");

const ADMIN = "00000000-0000-4000-8000-0000000000a1";
const MEMBER = "00000000-0000-4000-8000-0000000000b2";
const OUTSIDER = "00000000-0000-4000-8000-0000000000d4";

const SETUP = `
create role authenticated nologin;
create role anon nologin;
grant authenticated, anon to tester;
create schema auth;
create table auth.users (id uuid primary key);
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;
grant usage on schema auth to authenticated, anon;
grant execute on all functions in schema auth to authenticated, anon;
create schema app;
grant usage on schema app to authenticated, anon, tester;
insert into auth.users (id) values ('${ADMIN}'), ('${MEMBER}'), ('${OUTSIDER}');
create table app.organization_members (
  organization_id text not null,
  user_id uuid not null references auth.users on delete cascade,
  role text not null
);
insert into app.organization_members values
  ('acme', '${ADMIN}', 'admin'),
  ('acme', '${MEMBER}', 'member'),
  ('globex', '${OUTSIDER}', 'member');
create table app.project (id text primary key, "orgId" text not null, "ownerId" uuid not null);
create table app.task (
  id text primary key,
  "orgId" text not null,
  "authorId" uuid not null,
  locked boolean not null default false
);
insert into app.project values ('p-acme', 'acme', '${MEMBER}'), ('p-globex', 'globex', '${OUTSIDER}');
insert into app.task values
  ('t-own', 'acme', '${MEMBER}', false),
  ('t-other', 'acme', '${ADMIN}', false),
  ('t-globex', 'globex', '${OUTSIDER}', false);
`;

const member = {
  id: MEMBER,
  tenant: "acme",
  memberships: [{ tenant: "acme", roles: ["member"] }],
};
const outsider = {
  id: OUTSIDER,
  tenant: "globex",
  memberships: [{ tenant: "globex", roles: ["member"] }],
};

const FIXTURES = [
  {
    subject: member,
    row: { id: "t-own", orgId: "acme", authorId: MEMBER, locked: false },
    action: "task.update",
    expected: "granted",
  },
  {
    subject: member,
    row: { id: "t-other", orgId: "acme", authorId: ADMIN, locked: false },
    action: "task.update",
    expected: "denied",
  },
  {
    subject: outsider,
    row: { id: "p-acme", orgId: "acme", ownerId: MEMBER },
    action: "project.read",
    expected: "denied",
  },
  {
    subject: outsider,
    row: { id: "p-globex", orgId: "globex", ownerId: OUTSIDER },
    action: "project.read",
    expected: "granted",
  },
  {
    subject: member,
    row: { id: "t-new", orgId: "acme", authorId: MEMBER, locked: false },
    action: "task.create",
    expected: "granted",
  },
];

function testerUri(uri: string): string {
  const url = new URL(uri);
  url.username = "tester";
  url.password = "tester";
  return url.toString();
}

describe("rls.tables with schema-qualified names", () => {
  const dir = mkdtempSync(join(tmpdir(), "permdock-schema-tables-"));
  const fixturesPath = join(dir, "rls.fixtures.json");
  let db: Postgres | undefined;
  let generated = "";

  beforeAll(async () => {
    writeFileSync(fixturesPath, `${JSON.stringify(FIXTURES, null, 2)}\n`);
    const out = join(dir, "rls.sql");
    const result = await run(
      ["rls", "generate", "--target", "sql", "--out", out],
      { cwd: FIXTURE },
    );
    if (result.code !== 0) {
      throw new Error(`rls generate: ${result.stdout}`);
    }
    generated = readFileSync(out, "utf8");
    db = await startPostgres([SETUP, generated]);
  }, 240_000);

  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await db?.stop();
  });

  it("writes the policies on the tables in their own schema", () => {
    expect(generated).toContain(
      'alter table "app"."task" enable row level security;',
    );
    expect(generated).toContain('on "app"."project"');
    expect(generated).toContain('from "app"."organization_members" m');
    expect(generated).not.toContain('"public"."task"');
  });

  it("verifies every fixture against the tables in their own schema", async () => {
    if (db === undefined) {
      throw new Error("PermDock: Postgres was not started");
    }
    const result = await run(
      ["rls", "verify", "--db", testerUri(db.uri), "--fixtures", fixturesPath],
      { cwd: FIXTURE },
    );
    expect(result.stdout).toContain(
      `verified ${String(FIXTURES.length)} fixture(s)`,
    );
    expect(result.code).toBe(0);
  });

  it("writes pgTAP that names the schema-qualified tables", async () => {
    const result = await run(
      ["rls", "verify", "--format", "pgtap", "--fixtures", fixturesPath],
      { cwd: FIXTURE },
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('update "app"."task" set');
    expect(result.stdout).toContain('select "id" from "app"."project"');
  });
});
