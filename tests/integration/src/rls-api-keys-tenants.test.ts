import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "permdock/cli";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Postgres } from "./support/postgres.ts";

import { startPostgres } from "./support/postgres.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

const AUDITOR = "00000000-0000-4000-8000-0000000000a1";
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
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;
grant usage on schema auth to authenticated, anon;
grant execute on all functions in schema auth to authenticated, anon;
grant usage on schema public to authenticated, anon;
insert into auth.users (id) values ('${AUDITOR}'), ('${MEMBER}');
create table public.organization_members (
  organization_id text not null,
  user_id uuid not null references auth.users on delete cascade,
  role text not null
);
insert into public.organization_members values
  ('acme', '${MEMBER}', 'member'),
  ('globex', '${MEMBER}', 'member');
create table public.project (id text primary key, "orgId" text not null, "ownerId" uuid not null);
create table public.task (
  id text primary key,
  "orgId" text not null,
  "authorId" uuid not null,
  locked boolean not null default false
);
insert into public.task values
  ('t-acme-1', 'acme', '${MEMBER}', false),
  ('t-acme-2', 'acme', '${MEMBER}', false),
  ('t-globex', 'globex', '${MEMBER}', false),
  ('t-initech', 'initech', '${AUDITOR}', false);
`;

type Outcome = {
  readonly tasks: readonly string[];
  readonly tenants: readonly string[];
  readonly has: boolean;
};

describe("rls.apiKeys with rls.tenants all", () => {
  const dir = mkdtempSync(join(tmpdir(), "permdock-api-keys-tenants-"));
  let db: Postgres | undefined;

  beforeAll(async () => {
    const out = join(dir, "rls.sql");
    const result = await run(
      ["rls", "generate", "--target", "sql", "--out", out],
      { cwd: join(HERE, "../fixtures/api-keys-all-tenants") },
    );
    if (result.code !== 0) {
      throw new Error(`rls generate: ${result.stdout}`);
    }
    db = await startPostgres([
      SETUP,
      readFileSync(out, "utf8"),
      `insert into permdock.user_roles (user_id, role) values ('${AUDITOR}', 'auditor');`,
    ]);
  }, 240_000);

  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await db?.stop();
  });

  const as = async (
    claims: Readonly<Record<string, unknown>>,
  ): Promise<Outcome> => {
    if (db === undefined) {
      throw new Error("PermDock: Postgres was not started");
    }
    const target = db;
    let outcome: Outcome = { tasks: [], tenants: [], has: false };
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
        const tasks = await target.tester.query<{ readonly id: string }>(
          "select id from public.task order by id",
        );
        const tenants = await target.tester.query<{ readonly id: string }>(
          "select id from permdock.member_tenant_ids() id order by id",
        );
        const has = await target.tester.query<{ readonly has: boolean }>(
          "select permdock.permdock_has('task.read') as has",
        );
        outcome = {
          tasks: tasks.rows.map((row) => row.id),
          tenants: tenants.rows.map((row) => row.id),
          has: has.rows[0]?.has ?? false,
        };
      },
    );
    return outcome;
  };

  it("admits every tenant of the user without a key or with a key that names none", async () => {
    const every = {
      tasks: ["t-acme-1", "t-acme-2", "t-globex"],
      tenants: ["acme", "globex"],
      has: false,
    };
    expect(await as({ sub: MEMBER })).toEqual(every);
    expect(
      await as({ sub: MEMBER, api_key: { id: "k1", scopes: ["task.read"] } }),
    ).toEqual(every);
  });

  it("narrows a user key to the tenant it names", async () => {
    expect(
      await as({
        sub: MEMBER,
        api_key: { id: "k1", tenant: "acme", scopes: ["task.read"] },
      }),
    ).toEqual({
      tasks: ["t-acme-1", "t-acme-2"],
      tenants: ["acme"],
      has: false,
    });
    expect(
      await as({
        sub: MEMBER,
        api_key: { id: "k2", tenant: "globex", scopes: ["task.read"] },
      }),
    ).toEqual({ tasks: ["t-globex"], tenants: ["globex"], has: false });
  });

  it("admits nothing when the key names a tenant the user is not a member of", async () => {
    expect(
      await as({
        sub: MEMBER,
        api_key: { id: "k3", tenant: "initech", scopes: ["task.read"] },
      }),
    ).toEqual({ tasks: [], tenants: [], has: false });
  });

  it("drops global grants for a key that names a tenant", async () => {
    expect(await as({ sub: AUDITOR })).toMatchObject({
      tasks: ["t-acme-1", "t-acme-2", "t-globex", "t-initech"],
      has: true,
    });
    expect(
      await as({
        sub: AUDITOR,
        api_key: { id: "k4", tenant: "initech", scopes: ["task.read"] },
      }),
    ).toEqual({ tasks: [], tenants: [], has: false });
  });

  it("keeps a tenant service key to its tenant", async () => {
    expect(
      await as({
        sub: "",
        api_key: { id: "k5", tenant: "globex", scopes: ["task.read"] },
      }),
    ).toEqual({ tasks: ["t-globex"], tenants: ["globex"], has: false });
  });
});
