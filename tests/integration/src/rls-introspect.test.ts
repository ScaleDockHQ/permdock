import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "permdock/cli";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Postgres } from "./support/postgres.ts";

import { startPostgres } from "./support/postgres.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "../fixtures/introspect");

const ORG = "a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11";
const USER = "00000000-0000-4000-8000-0000000000c1";

const SETUP = `
create role authenticated nologin;
create role anon nologin;
grant authenticated to tester;
grant usage on schema public to authenticated, anon;
create schema auth;
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;
grant usage on schema auth to authenticated, anon;
grant execute on all functions in schema auth to authenticated, anon;
create table doc (id text primary key, "orgId" uuid not null, tags text[] not null);
insert into doc values ('open', '${ORG}', '{public,news}'), ('closed', '${ORG}', '{private}');
`;

function claims(extra: Readonly<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    sub: USER,
    role: "authenticated",
    tenant_id: ORG,
    memberships: [{ scope: "tenant", id: ORG, roles: ["member"] }],
    ...extra,
  });
}

async function verify(uri: string): Promise<{ code: number; out: string }> {
  const result = await run(
    ["rls", "verify", "--introspect", "--db", uri, "--dialect", "supabase"],
    { cwd: FIXTURE },
  );
  return { code: result.code, out: `${result.stdout}${result.stderr}` };
}

describe("rls verify --introspect", () => {
  let db: Postgres | undefined;

  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "permdock-introspect-"));
    const out = join(dir, "rls.sql");
    const result = await run(
      [
        "rls",
        "generate",
        "--target",
        "sql",
        "--dialect",
        "supabase",
        "--out",
        out,
      ],
      { cwd: FIXTURE },
    );
    if (result.code !== 0) {
      throw new Error(`rls generate: ${result.stdout}${result.stderr}`);
    }
    const generated = readFileSync(out, "utf8");
    rmSync(dir, { recursive: true, force: true });
    db = await startPostgres([SETUP, generated]);
  }, 120_000);

  afterAll(async () => {
    await db?.stop();
  });

  function started(): Postgres {
    if (db === undefined) {
      throw new Error("PermDock: Postgres was not started");
    }
    return db;
  }

  it("reads rows whose array column contains the value", async () => {
    const pg = started();
    const ids = await pg.as(
      { role: "authenticated", settings: { "request.jwt.claims": claims() } },
      async () =>
        (await pg.tester.query("select id from doc order by id")).rows.map(
          (row: { id: string }) => row.id,
        ),
    );
    expect(ids).toEqual(["open"]);
  });

  it("refuses a delete from a delegated oauth client", async () => {
    const pg = started();
    const deleted = async (extra: Readonly<Record<string, unknown>>) =>
      pg.as(
        {
          role: "authenticated",
          settings: { "request.jwt.claims": claims(extra) },
        },
        async () =>
          (await pg.tester.query("delete from doc where id = 'open'")).rowCount,
      );
    expect(await deleted({})).toBe(1);
    expect(await deleted({ client_id: "app-1" })).toBe(0);
    expect(await deleted({ act: { sub: "agent-1" } })).toBe(0);
  });

  it("finds no drift in the generated database", async () => {
    const result = await verify(started().uri);
    expect(result.out).toContain("no drift");
    expect(result.code).toBe(0);
  });

  it("warns about a scope column no index starts with, and accepts one that does", async () => {
    const pg = started();
    const warning =
      "warning: public.doc: no index starts with orgId, which the policies or helpers filter on";
    expect((await verify(pg.uri)).out).toContain(warning);
    await pg.admin.query('create index doc_org_id_tags on doc ("orgId", tags)');
    const result = await verify(pg.uri);
    expect(result.out).not.toContain(warning);
    expect(result.code).toBe(0);
  });

  it("suggests only indexes the database lacks with rls generate --db", async () => {
    const pg = started();
    const dir = mkdtempSync(join(tmpdir(), "permdock-introspect-db-"));
    const suggest = async (): Promise<string> => {
      const result = await run(
        [
          "rls",
          "generate",
          "--target",
          "sql",
          "--dialect",
          "supabase",
          "--out",
          join(dir, "rls.sql"),
          "--db",
          pg.uri,
        ],
        { cwd: FIXTURE },
      );
      expect(result.code).toBe(0);
      return `${result.stdout}${result.stderr}`;
    };
    try {
      await pg.admin.query("drop index if exists doc_org_id_tags");
      const suggestion = "index suggestion: create index on public.doc (orgId)";
      expect(await suggest()).toContain(suggestion);
      await pg.admin.query('create index doc_org_lead on doc ("orgId", id)');
      const covered = await suggest();
      expect(covered).not.toContain(suggestion);
      expect(covered).not.toContain("(tags)");
    } finally {
      await pg.admin.query(
        'drop index if exists doc_org_lead; create index if not exists doc_org_id_tags on doc ("orgId", tags)',
      );
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reports policies, grants, RLS and helpers that drifted", async () => {
    const pg = started();
    await pg.admin.query(`
      create policy "hand_written" on doc for select to authenticated using (true);
      grant insert on doc to authenticated;
      alter function permdock.permdock_has(text) security invoker;
      alter function permdock.permitted_tenant_ids(text) reset search_path;
    `);
    const result = await verify(pg.uri);
    expect(result.code).toBe(1);
    expect(result.out.split("\n")).toEqual(
      expect.arrayContaining([
        "public.doc: policy hand_written is not generated (permissive select); a permissive one widens access",
        "public.doc: authenticated holds insert, which no generated policy allows",
        "permdock.permdock_has: helper is not security definer",
        "permdock.permitted_tenant_ids: helper does not set search_path = ''",
      ]),
    );
    await pg.admin.query("alter table doc disable row level security");
    expect((await verify(pg.uri)).out).toContain(
      "public.doc: row level security is disabled",
    );
  });
});
