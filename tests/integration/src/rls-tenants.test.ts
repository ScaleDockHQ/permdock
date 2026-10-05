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
insert into auth.users (id) values ('${ADMIN}');
create table public.organization_members (
  organization_id text not null,
  user_id uuid not null references auth.users on delete cascade,
  role text not null
);
insert into public.organization_members values
  ('acme', '${ADMIN}', 'admin'),
  ('globex', '${ADMIN}', 'admin');
create table public.job (id text primary key, "orgId" text not null, "ownerId" uuid not null);
insert into public.job values
  ('j1', 'acme', '${ADMIN}'),
  ('j2', 'globex', '${ADMIN}'),
  ('j3', 'initech', '${ADMIN}');
`;

async function generated(fixture: string, dir: string): Promise<string> {
  const out = join(dir, `${fixture}.sql`);
  const result = await run(
    ["rls", "generate", "--target", "sql", "--out", out],
    { cwd: join(HERE, "../fixtures", fixture) },
  );
  if (result.code !== 0) {
    throw new Error(`rls generate: ${result.stdout}`);
  }
  return readFileSync(out, "utf8");
}

describe("rls.tenants", () => {
  const dir = mkdtempSync(join(tmpdir(), "permdock-rls-tenants-"));
  const databases: Record<string, Postgres> = {};

  beforeAll(async () => {
    for (const fixture of ["custom-role-writes", "rls-tenants-all"]) {
      databases[fixture] = await startPostgres([
        SETUP,
        await generated(fixture, dir),
      ]);
    }
  }, 240_000);

  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    for (const db of Object.values(databases)) {
      await db.stop();
    }
  });

  const visible = async (
    fixture: string,
    claims: Readonly<Record<string, unknown>>,
  ): Promise<readonly string[]> => {
    const db = databases[fixture];
    if (db === undefined) {
      throw new Error("PermDock: Postgres was not started");
    }
    return db.as(
      {
        role: "authenticated",
        settings: {
          "request.jwt.claims": JSON.stringify({
            sub: ADMIN,
            role: "authenticated",
            ...claims,
          }),
        },
      },
      async () => {
        const result = await db.tester.query<{ id: string }>(
          "select id from public.job order by id",
        );
        return result.rows.map((row) => row.id);
      },
    );
  };

  it("narrows to the tenant claim by default and admits every member tenant without one", async () => {
    expect(await visible("custom-role-writes", { tenant_id: "acme" })).toEqual([
      "j1",
    ]);
    expect(await visible("custom-role-writes", {})).toEqual(["j1", "j2"]);
  });

  it("admits every member tenant whatever the claim says with tenants 'all'", async () => {
    expect(await visible("rls-tenants-all", { tenant_id: "acme" })).toEqual([
      "j1",
      "j2",
    ]);
    expect(await visible("rls-tenants-all", {})).toEqual(["j1", "j2"]);
  });
});
