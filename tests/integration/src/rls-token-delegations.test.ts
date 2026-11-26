import { PGlite } from "@electric-sql/pglite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { rlsGenerate } from "./support/rls.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "../fixtures/token-delegations");

const OWNER = "00000000-0000-4000-8000-0000000000e1";
const ORG = "00000000-0000-4000-8000-0000000000f1";

const SETUP = `
create role authenticated nologin;
create role anon nologin;
create role service_role nologin;
create role supabase_auth_admin nologin;
create schema auth;
create table auth.users (id uuid primary key);
create function auth.jwt() returns jsonb language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true), '')::jsonb
$$;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;
grant usage on schema auth to authenticated, anon;
grant execute on all functions in schema auth to authenticated, anon;
grant usage on schema public to authenticated, anon;
insert into auth.users (id) values ('${OWNER}');
create table public.organization_members (
  organization_id uuid not null,
  user_id uuid not null references auth.users on delete cascade,
  role text not null
);
insert into public.organization_members values ('${ORG}', '${OWNER}', 'owner');
create table public.task (id text primary key, "orgId" uuid not null, title text);
insert into public.task values ('t1', '${ORG}', 'first');
grant select, update on public.task to authenticated;
`;

describe("rls.tokenScopes with delegations", () => {
  const dir = mkdtempSync(join(tmpdir(), "permdock-token-delegations-"));
  let lite: PGlite | undefined;

  beforeAll(async () => {
    const out = join(dir, "rls.sql");
    const generated = await rlsGenerate(["--target", "sql", "--out", out], {
      cwd: FIXTURE,
    });
    if (generated.code !== 0) {
      throw new Error(`rls generate: ${generated.stdout}${generated.stderr}`);
    }
    lite = new PGlite();
    await lite.exec(SETUP);
    await lite.exec(readFileSync(out, "utf8"));
  }, 120_000);

  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await lite?.close();
  });

  const rows = async (
    claims: Readonly<Record<string, unknown>>,
  ): Promise<{ readonly read: number; readonly updated: number }> => {
    if (lite === undefined) {
      throw new Error("PermDock: PGlite did not start");
    }
    await lite.exec("begin;");
    try {
      await lite.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: OWNER, role: "authenticated", ...claims }),
      ]);
      await lite.exec("set local role authenticated;");
      const read = await lite.query<{ readonly n: number }>(
        "select count(*)::int as n from public.task",
      );
      const updated = await lite.query(
        "update public.task set title = 'changed' where id = 't1'",
      );
      return {
        read: read.rows[0]?.n ?? -1,
        updated: updated.affectedRows ?? -1,
      };
    } finally {
      await lite.exec("rollback");
    }
  };

  it("caps an OAuth client token with identity scopes at the delegation", async () => {
    expect(await rows({})).toStrictEqual({ read: 1, updated: 1 });
    expect(
      await rows({ client_id: "mcp-client", scope: "openid email" }),
    ).toStrictEqual({ read: 1, updated: 0 });
    expect(
      await rows({ act: { sub: "agent-1" }, scope: "openid" }),
    ).toStrictEqual({ read: 0, updated: 0 });
  });
});
