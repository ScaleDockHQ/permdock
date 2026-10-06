import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "permdock/cli";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Postgres } from "./support/postgres.ts";

import { startPostgres } from "./support/postgres.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

const ADMIN = "00000000-0000-4000-8000-0000000000a1";
const MEMBER = "00000000-0000-4000-8000-0000000000b2";

const SETUP = `
create role authenticated nologin;
create role anon nologin;
grant authenticated, anon to tester;
create schema auth;
create table auth.users (id uuid primary key);
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')
  )::jsonb
$$;
create function auth.uid() returns uuid language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;
grant usage on schema auth to authenticated, anon;
grant execute on all functions in schema auth to authenticated, anon;
grant usage on schema public to authenticated, anon;
insert into auth.users (id) values ('${ADMIN}'), ('${MEMBER}');
create table public.organization_members (
  organization_id text not null,
  user_id uuid not null references auth.users on delete cascade,
  role text not null
);
insert into public.organization_members values
  ('acme', '${ADMIN}', 'admin'),
  ('acme', '${MEMBER}', 'member');
create table public.project (id text primary key, "orgId" text not null, "ownerId" uuid not null);
create table public.task (
  id text primary key,
  "orgId" text not null,
  "authorId" uuid not null,
  locked boolean not null default false
);
insert into public.task values
  ('t-own', 'acme', '${MEMBER}', false),
  ('t-other', 'acme', '${ADMIN}', false),
  ('t-locked', 'acme', '${MEMBER}', true),
  ('t-globex', 'globex', '${ADMIN}', false);
`;

type Outcome = {
  readonly user: string | null;
  readonly read: number;
  readonly updated: number;
  readonly tenants: readonly string[];
};

describe("permdock_user_id with Supabase's auth.uid()", () => {
  const dir = mkdtempSync(join(tmpdir(), "permdock-user-id-"));
  let db: Postgres | undefined;

  beforeAll(async () => {
    const out = join(dir, "rls.sql");
    const result = await run(
      ["rls", "generate", "--target", "sql", "--out", out],
      { cwd: join(HERE, "../fixtures/api-keys") },
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

  const started = (): Postgres => {
    if (db === undefined) {
      throw new Error("PermDock: Postgres was not started");
    }
    return db;
  };

  const as = async (
    settings: Readonly<Record<string, string>>,
  ): Promise<Outcome> => {
    const target = started();
    return target.as({ role: "authenticated", settings }, async () => {
      const user = await target.tester.query<{ readonly id: string | null }>(
        "select permdock.permdock_user_id() as id",
      );
      const read =
        (await target.tester.query("select id from public.task")).rowCount ?? 0;
      const tenants = await target.tester.query<{ readonly id: string }>(
        "select id from permdock.member_tenant_ids() id order by id",
      );
      const updated =
        (
          await target.tester.query(
            "update public.task set locked = locked where id = 't-own'",
          )
        ).rowCount ?? 0;
      return {
        user: user.rows[0]?.id ?? null,
        read,
        updated,
        tenants: tenants.rows.map((row) => row.id),
      };
    });
  };

  const claims = (value: Readonly<Record<string, unknown>>): string =>
    JSON.stringify({ role: "authenticated", ...value });

  it("reads the subject from the request.jwt.claims JSON", async () => {
    expect(await as({ "request.jwt.claims": claims({ sub: MEMBER }) })).toEqual(
      { user: MEMBER, read: 3, updated: 1, tenants: ["acme"] },
    );
  });

  it("reads the subject from the legacy request.jwt.claim.sub setting, as auth.uid() does", async () => {
    expect(await as({ "request.jwt.claim.sub": MEMBER })).toEqual({
      user: MEMBER,
      read: 3,
      updated: 1,
      tenants: ["acme"],
    });
    expect(
      await as({
        "request.jwt.claim.sub": MEMBER,
        "request.jwt.claims": claims({ sub: ADMIN }),
      }),
    ).toMatchObject({ user: MEMBER, updated: 1 });
    expect(
      await as({
        "request.jwt.claim.sub": MEMBER,
        "request.jwt.claims": claims({
          api_key: { id: "k1", scopes: ["task.read"] },
        }),
      }),
    ).toEqual({ user: MEMBER, read: 3, updated: 0, tenants: ["acme"] });
  });

  it("agrees with auth.uid() whenever auth.uid() answers", async () => {
    const target = started();
    for (const settings of [
      { "request.jwt.claims": claims({ sub: MEMBER }) },
      { "request.jwt.claim.sub": ADMIN },
      { "request.jwt.claims": claims({}) },
      {},
    ]) {
      const same = await target.as(
        { role: "authenticated", settings },
        async () =>
          (
            await target.tester.query<{ readonly same: boolean }>(
              "select permdock.permdock_user_id() is not distinct from auth.uid() as same",
            )
          ).rows[0]?.same,
      );
      expect(same).toBe(true);
    }
  });

  it("reads a tenant service key's empty sub as no user instead of failing", async () => {
    const settings = {
      "request.jwt.claims": claims({
        sub: "",
        api_key: { id: "k3", tenant: "acme", scopes: ["task.read"] },
      }),
    };
    expect(await as(settings)).toEqual({
      user: null,
      read: 3,
      updated: 0,
      tenants: ["acme"],
    });
    const target = started();
    await expect(
      target.as({ role: "authenticated", settings }, () =>
        target.tester.query("select auth.uid()"),
      ),
    ).rejects.toMatchObject({ code: "22P02" });
  });
});
