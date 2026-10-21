import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "permdock/cli";
import { DatabaseError } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Postgres } from "./support/postgres.ts";

import { startPostgres } from "./support/postgres.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "../fixtures/custom-role-ordered-levels");

const LEAD = "00000000-0000-4000-8000-0000000000b2";
const CLOSER = "00000000-0000-4000-8000-0000000000c3";

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
insert into auth.users (id) values ('${LEAD}'), ('${CLOSER}');
create table public.organization_members (
  organization_id text not null,
  user_id uuid not null references auth.users on delete cascade,
  role text not null
);
insert into public.organization_members values
  ('acme', '${LEAD}', 'lead'),
  ('acme', '${CLOSER}', 'closer');
create table public.job (
  id text primary key,
  "orgId" text not null,
  "ownerId" uuid not null,
  status text not null
);
`;

describe("orderedLevels in permdock_replace_custom_role_grants", () => {
  let db: Postgres | undefined;
  const dir = mkdtempSync(join(tmpdir(), "permdock-ordered-levels-"));

  beforeAll(async () => {
    const out = join(dir, "rls.sql");
    const result = await run(
      ["rls", "generate", "--target", "sql", "--out", out],
      { cwd: FIXTURE },
    );
    if (result.code !== 0) {
      throw new Error(`rls generate: ${result.stdout}`);
    }
    db = await startPostgres([SETUP, readFileSync(out, "utf8")]);
  }, 180_000);

  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await db?.stop();
  });

  const save = async (
    sub: string,
    role: string,
    allow: readonly string[],
  ): Promise<string> => {
    if (db === undefined) {
      throw new Error("PermDock: Postgres was not started");
    }
    try {
      await db.as(
        {
          role: "authenticated",
          settings: {
            "request.jwt.claims": JSON.stringify({
              sub,
              role: "authenticated",
            }),
          },
        },
        async () => {
          await db?.tester.query(
            "select permdock.permdock_replace_custom_role_grants('acme', 'tenant', null, $1, $2, '{}', '{}')",
            [role, [...allow]],
          );
        },
      );
      return "ok";
    } catch (error) {
      return error instanceof DatabaseError
        ? `${error.code ?? ""} ${error.hint ?? ""}`.trim()
        : String(error);
    }
  };

  it("lets a conditioned grant hand out its level and every narrower one", async () => {
    expect(await save(LEAD, "opener", ["job.update@open"])).toBe("ok");
    expect(await save(LEAD, "self-service", ["job.update@own"])).toBe("ok");
    expect(await save(LEAD, "wide", ["job.update@all"])).toBe(
      "42501 not-assignable-by",
    );
  });

  it("lets a custom-role level hand out every narrower one", async () => {
    await db?.admin.query(
      "insert into permdock.custom_role_permissions (tenant_id, scope, scope_id, role, permission, effect, level) values ('acme', 'tenant', null, 'closer', 'job.update', 'allow', 'open')",
    );
    expect(await save(CLOSER, "own-closer", ["job.update@own"])).toBe("ok");
    expect(await save(CLOSER, "wide-closer", ["job.update@all"])).toBe(
      "42501 not-assignable-by",
    );
  });
});
