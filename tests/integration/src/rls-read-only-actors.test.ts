import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "permdock/cli";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Postgres } from "./support/postgres.ts";

import { startPostgres } from "./support/postgres.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

const OWNER = "00000000-0000-4000-8000-0000000000e1";
const STAFF = "00000000-0000-4000-8000-0000000000e2";

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
grant usage on schema public to authenticated, anon;
insert into auth.users (id) values ('${OWNER}'), ('${STAFF}');
create table public.organization_members (
  organization_id text not null,
  user_id uuid not null references auth.users on delete cascade,
  role text not null
);
insert into public.organization_members values ('acme', '${OWNER}', 'owner');
create table public.job (id text primary key, "orgId" text not null, title text);
insert into public.job values ('j1', 'acme', 'first');
grant select, update on public.job to authenticated;
`;

describe("rls.readOnlyActors", () => {
  const dir = mkdtempSync(join(tmpdir(), "permdock-read-only-actors-"));
  let db: Postgres | undefined;

  beforeAll(async () => {
    const out = join(dir, "rls.sql");
    const result = await run(
      ["rls", "generate", "--target", "sql", "--out", out],
      { cwd: join(HERE, "../fixtures/read-only-actors") },
    );
    if (result.code !== 0) {
      throw new Error(`rls generate: ${result.stdout}`);
    }
    db = await startPostgres([SETUP, readFileSync(out, "utf8")]);
  }, 240_000);

  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await db?.stop();
  });

  const as = async (
    act?: Readonly<Record<string, unknown>>,
  ): Promise<{ readonly read: number; readonly updated: number }> => {
    if (db === undefined) {
      throw new Error("PermDock: Postgres was not started");
    }
    const target = db;
    let read = 0;
    let updated = 0;
    await target.as(
      {
        role: "authenticated",
        settings: {
          "request.jwt.claims": JSON.stringify({
            sub: OWNER,
            role: "authenticated",
            ...(act === undefined ? {} : { act }),
          }),
        },
      },
      async () => {
        read =
          (await target.tester.query("select id from public.job")).rowCount ??
          0;
        updated =
          (
            await target.tester.query(
              "update public.job set title = 'changed' where id = 'j1'",
            )
          ).rowCount ?? 0;
      },
    );
    return { read, updated };
  };

  it("keeps the user's own writes and makes a support session read-only", async () => {
    expect(await as()).toEqual({ read: 1, updated: 1 });
    expect(
      await as({
        sub: STAFF,
        kind: "support",
        session_id: "s1",
        read_only: true,
      }),
    ).toEqual({ read: 1, updated: 0 });
    expect(await as({ sub: STAFF, kind: "support", session_id: "s1" })).toEqual(
      { read: 1, updated: 0 },
    );
    expect(await as({ sub: STAFF, session_id: "s1" })).toEqual({
      read: 1,
      updated: 0,
    });
    expect(await as({ sub: STAFF, kind: "impersonation" })).toEqual({
      read: 1,
      updated: 0,
    });
  });

  it("lets a session the token marks read_only false write, and leaves other actor kinds alone", async () => {
    expect(
      await as({
        sub: STAFF,
        kind: "support",
        session_id: "s1",
        read_only: false,
      }),
    ).toEqual({ read: 1, updated: 1 });
    expect(await as({ sub: "agent-1", kind: "agent" })).toEqual({
      read: 1,
      updated: 1,
    });
  });
});
