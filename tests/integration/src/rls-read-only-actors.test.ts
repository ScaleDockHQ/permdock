import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Postgres } from "./support/postgres.ts";

import { runPipingDbUrl } from "./db-url.ts";
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
    const result = await runPipingDbUrl(
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

const HAND_WRITTEN = `
alter table public.job enable row level security;
create policy job_select on public.job for select to authenticated using (true);
create policy job_update on public.job for update to authenticated using (true) with check (true);
create policy job_update_actor on public.job as restrictive for update to authenticated
  using ((select permdock.permdock_actor_may_write()))
  with check ((select permdock.permdock_actor_may_write()));
`;

describe("rls.readOnlyActors with --helpers-only", () => {
  const dir = mkdtempSync(join(tmpdir(), "permdock-read-only-helpers-"));
  const fixture = join(HERE, "../fixtures/read-only-actors");
  let db: Postgres | undefined;

  beforeAll(async () => {
    const out = join(dir, "rls.sql");
    const result = await runPipingDbUrl(
      ["rls", "generate", "--target", "sql", "--helpers-only", "--out", out],
      { cwd: fixture },
    );
    if (result.code !== 0) {
      throw new Error(`rls generate: ${result.stdout}`);
    }
    db = await startPostgres([SETUP, readFileSync(out, "utf8"), HAND_WRITTEN]);
  }, 240_000);

  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await db?.stop();
  });

  const started = (): Postgres => {
    if (db === undefined) {
      throw new Error("PermDock: Postgres was not started");
    }
    return db;
  };

  const updates = async (
    act?: Readonly<Record<string, unknown>>,
  ): Promise<number> => {
    const target = started();
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
        updated =
          (
            await target.tester.query(
              "update public.job set title = 'changed' where id = 'j1'",
            )
          ).rowCount ?? 0;
      },
    );
    return updated;
  };

  const verify = async () => {
    const result = await runPipingDbUrl(
      [
        "rls",
        "verify",
        "--introspect",
        "--helpers-only",
        "--db-url",
        started().uri,
        "--dialect",
        "supabase",
      ],
      { cwd: fixture },
    );
    return { code: result.code, out: `${result.stdout}${result.stderr}` };
  };

  it("refuses a read-only support session through a hand-written policy that calls permdock_actor_may_write", async () => {
    expect(await updates()).toBe(1);
    expect(
      await updates({ sub: STAFF, kind: "support", session_id: "s1" }),
    ).toBe(0);
    expect(
      await updates({
        sub: STAFF,
        kind: "support",
        session_id: "s1",
        read_only: false,
      }),
    ).toBe(1);
  });

  it("verify --introspect names a write policy without the check", async () => {
    expect((await verify()).code).toBe(0);
    await started().admin.query("drop policy job_update_actor on public.job");
    const drift = await verify();
    expect(drift.code).toBe(1);
    expect(drift.out).toContain(
      "public.job: update policies for authenticated do not call permdock_actor_may_write()",
    );
  });
});
