import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "permdock/cli";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { SupabasePostgres } from "./support/supabase-postgres.ts";

import { generatedFindings, runSplinter } from "./support/splinter.ts";
import { startSupabasePostgres } from "./support/supabase-postgres.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const ADMIN = "00000000-0000-4000-8000-0000000000a1";
const OTHER = "00000000-0000-4000-8000-0000000000b2";
const LIVE = "11111111-1111-4111-8111-111111111111";
const EXPIRED = "22222222-2222-4222-8222-222222222222";
const OTHERS = "33333333-3333-4333-8333-333333333333";
const REVOKED = "44444444-4444-4444-8444-444444444444";

/** Rows the Auth server writes on sign-in; the image ships its `auth.users` and `auth.sessions`. */
const AUTH = `
insert into auth.users (id) values ('${ADMIN}'), ('${OTHER}');
insert into auth.sessions (id, user_id, not_after) values
  ('${LIVE}', '${ADMIN}', null),
  ('${EXPIRED}', '${ADMIN}', now() - interval '1 minute'),
  ('${OTHERS}', '${OTHER}', null);
`;

const APP = `
create table public.organization_members (organization_id text not null, user_id uuid not null, role text not null);
create table public.project (id text primary key, "orgId" text not null, "ownerId" uuid not null);
create table public.task (id text primary key, "orgId" text not null, "authorId" uuid not null, locked boolean not null default false);
grant select, insert, update, delete on public.project, public.task to authenticated;
insert into public.organization_members values ('acme', '${ADMIN}', 'admin');
insert into public.project values ('p1', 'acme', '${ADMIN}');
`;

let db: SupabasePostgres | undefined;
let generated = "";

function started(): SupabasePostgres {
  if (db === undefined) {
    throw new Error("PermDock: supabase/postgres was not started");
  }
  return db;
}

async function generate(): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "permdock-live-session-"));
  try {
    const out = join(dir, "out.sql");
    const result = await run(
      ["rls", "generate", "--target", "sql", "--out", out],
      { cwd: join(HERE, "../fixtures/live-session") },
    );
    if (result.code !== 0) {
      throw new Error(`rls generate: ${result.stdout}${result.stderr}`);
    }
    return readFileSync(out, "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Runs `sql` as `authenticated` with these claims, then rolls back. */
async function as<T extends Record<string, unknown>>(
  claims: Readonly<Record<string, unknown>>,
  sql: string,
): Promise<T[]> {
  const { tester } = started();
  await tester.query("begin");
  try {
    await tester.query("set local role authenticated");
    await tester.query("select set_config('request.jwt.claims', $1, true)", [
      JSON.stringify(claims),
    ]);
    return (await tester.query<T>(sql)).rows;
  } finally {
    await tester.query("rollback");
  }
}

const admin = (sessionId?: unknown) => ({
  sub: ADMIN,
  role: "authenticated",
  ...(sessionId === undefined ? {} : { session_id: sessionId }),
});

const update = "update public.project set id = id where id = 'p1' returning id";

beforeAll(async () => {
  generated = await generate();
  db = await startSupabasePostgres();
  await db.superuser.query(AUTH);
  await db.owner.query(APP);
  await db.owner.query(generated);
}, 240_000);

afterAll(async () => {
  await db?.stop();
});

describe("{ subject: { session: { live: true } } } on supabase/postgres", () => {
  it("updates on a session auth.sessions holds for the caller", async () => {
    expect(await as(admin(LIVE), update)).toEqual([{ id: "p1" }]);
  });

  it.each([
    ["a revoked session", REVOKED],
    ["an expired session", EXPIRED],
    ["another user's session", OTHERS],
    ["a malformed session_id", "not-a-uuid"],
    ["a non-string session_id", 42],
    ["no session_id", undefined],
  ])("updates nothing on %s", async (_, sessionId) => {
    expect(await as(admin(sessionId), update)).toEqual([]);
  });

  it("leaves reads that do not ask for a live session alone", async () => {
    expect(await as(admin(REVOKED), "select id from public.project")).toEqual([
      { id: "p1" },
    ]);
  });

  it("keeps permdock_session_live() from anon", async () => {
    const { tester } = started();
    await tester.query("begin");
    try {
      await tester.query("set local role anon");
      await expect(
        tester.query(`select "permdock".permdock_session_live()`),
      ).rejects.toMatchObject({ code: "42501" });
    } finally {
      await tester.query("rollback");
    }
  });

  it("raises no WARN or ERROR lint on the generated SQL", async () => {
    const findings = await runSplinter(started().owner);
    expect(generatedFindings(findings, generated)).toEqual([]);
  }, 120_000);
});
