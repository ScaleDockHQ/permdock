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
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
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
  readonly read: number;
  readonly updated: number;
  readonly has?: boolean;
};

describe("rls.apiKeys", () => {
  const dir = mkdtempSync(join(tmpdir(), "permdock-api-keys-"));
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
    db = await startPostgres([
      SETUP,
      readFileSync(out, "utf8"),
      `insert into permdock.user_roles (user_id, role) values ('${ADMIN}', 'auditor');`,
    ]);
  }, 240_000);

  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await db?.stop();
  });

  const as = async (
    claims: Readonly<Record<string, unknown>>,
    update = "t-own",
  ): Promise<Outcome> => {
    if (db === undefined) {
      throw new Error("PermDock: Postgres was not started");
    }
    const target = db;
    let outcome: Outcome = { read: 0, updated: 0 };
    await target.as(
      {
        role: "authenticated",
        settings: {
          "request.jwt.claims": JSON.stringify({
            role: "authenticated",
            ...claims,
          }),
        },
      },
      async () => {
        const read =
          (await target.tester.query("select id from public.task")).rowCount ??
          0;
        const has = (
          await target.tester.query<{ readonly has: boolean }>(
            "select permdock.permdock_has('task.read') as has",
          )
        ).rows[0]?.has;
        const updated =
          (
            await target.tester.query(
              "update public.task set locked = locked where id = $1",
              [update],
            )
          ).rowCount ?? 0;
        outcome = { read, updated, ...(has === undefined ? {} : { has }) };
      },
    );
    return outcome;
  };

  it("leaves a request without a key alone", async () => {
    expect(await as({ sub: MEMBER })).toEqual({
      read: 3,
      updated: 1,
      has: false,
    });
    expect(await as({ sub: ADMIN })).toMatchObject({ read: 4, has: true });
  });

  it("caps a user key at its scopes", async () => {
    expect(
      await as({ sub: MEMBER, api_key: { id: "k1", scopes: ["task.read"] } }),
    ).toEqual({ read: 3, updated: 0, has: false });
    expect(
      await as({
        sub: MEMBER,
        api_key: { id: "k1", scopes: ["task.read", "task.update"] },
      }),
    ).toEqual({ read: 3, updated: 1, has: false });
    expect(
      await as({ sub: ADMIN, api_key: { id: "k2", scopes: ["task.update"] } }),
    ).toMatchObject({ read: 0, has: false });
  });

  it("keeps denies when the key holds the permission", async () => {
    expect(
      await as(
        {
          sub: MEMBER,
          api_key: { id: "k1", scopes: ["task.read", "task.update"] },
        },
        "t-locked",
      ),
    ).toMatchObject({ updated: 0 });
  });

  it("grants nothing to a key whose scopes are not a list", async () => {
    expect(
      await as({ sub: MEMBER, api_key: { id: "k1", scopes: "task.read" } }),
    ).toEqual({ read: 0, updated: 0, has: false });
    expect(await as({ sub: MEMBER, api_key: "k1" })).toEqual({
      read: 0,
      updated: 0,
      has: false,
    });
  });

  it("treats a tenant key without a subject as a service principal of that tenant", async () => {
    expect(
      await as({
        sub: "",
        api_key: { id: "k3", tenant: "acme", scopes: ["task.read"] },
      }),
    ).toEqual({ read: 3, updated: 0, has: false });
    expect(
      await as(
        {
          sub: "",
          api_key: {
            id: "k3",
            tenant: "acme",
            roles: ["admin"],
            scopes: ["task.read", "task.update"],
          },
        },
        "t-other",
      ),
    ).toEqual({ read: 3, updated: 1, has: false });
    expect(
      await as(
        {
          api_key: {
            id: "k3",
            tenant: "acme",
            roles: ["admin"],
            scopes: ["task.read"],
          },
        },
        "t-other",
      ),
    ).toEqual({ read: 3, updated: 0, has: false });
    expect(
      await as({
        sub: "",
        api_key: { id: "k3", tenant: "acme", roles: [], scopes: ["task.read"] },
      }),
    ).toEqual({ read: 0, updated: 0, has: false });
  });
});
