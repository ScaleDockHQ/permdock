import { PGlite } from "@electric-sql/pglite";
import { renderModules } from "better-supabase/sql";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { authorizationProvider } from "permdock/better-supabase";
import { run } from "permdock/cli";
import { supabaseHookManifestFixture } from "permdock/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "../fixtures/token-scopes");

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

type Answer = {
  readonly moduleRead: unknown;
  readonly moduleUpdate: unknown;
  readonly rowsRead: number;
  readonly rowsUpdated: number;
};

describe("rls.tokenScopes", () => {
  const dir = mkdtempSync(join(tmpdir(), "permdock-token-scopes-"));
  let lite: PGlite | undefined;

  beforeAll(async () => {
    const out = join(dir, "rls.sql");
    const generated = await run(
      ["rls", "generate", "--target", "sql", "--out", out],
      { cwd: FIXTURE },
    );
    if (generated.code !== 0) {
      throw new Error(`rls generate: ${generated.stdout}${generated.stderr}`);
    }
    const exported = await run(["catalog"], { cwd: FIXTURE });
    if (exported.code !== 0) {
      throw new Error(`catalog: ${exported.stdout}`);
    }
    const provider = authorizationProvider({
      manifest: supabaseHookManifestFixture,
      catalog: exported.stdout,
    });
    lite = new PGlite();
    await lite.exec(SETUP);
    for (const file of renderModules(["access"], {
      delegationScopes: provider.delegation?.scopes ?? {},
    })) {
      await lite.exec(file.contents);
    }
    await lite.exec(
      `insert into better_supabase.memberships (organization_id, user_id, role) values ('${ORG}', '${OWNER}', 'owner');`,
    );
    await lite.exec(readFileSync(out, "utf8"));
  }, 120_000);

  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await lite?.close();
  });

  const answer = async (
    claims: Readonly<Record<string, unknown>>,
  ): Promise<Answer> => {
    if (lite === undefined) {
      throw new Error("PermDock: PGlite did not start");
    }
    await lite.exec("begin;");
    try {
      await lite.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: OWNER, role: "authenticated", ...claims }),
      ]);
      const memberCan = async (permission: string): Promise<unknown> =>
        (
          await lite?.query<{ readonly ok: unknown }>(
            "select better_supabase.member_can($1::uuid, $2::uuid, $3) as ok",
            [OWNER, ORG, permission],
          )
        )?.rows[0]?.ok;
      const moduleRead = await memberCan("task.read");
      const moduleUpdate = await memberCan("task.update");
      await lite.exec("set local role authenticated;");
      const read = await lite.query<{ readonly n: number }>(
        "select count(*)::int as n from public.task",
      );
      const updated = await lite.query(
        "update public.task set title = 'changed' where id = 't1'",
      );
      return {
        moduleRead,
        moduleUpdate,
        rowsRead: read.rows[0]?.n ?? -1,
        rowsUpdated: updated.affectedRows ?? -1,
      };
    } finally {
      await lite.exec("rollback");
    }
  };

  it("agrees with better-supabase's member_can for each token", async () => {
    const tokens = {
      user: {},
      mcpRead: { client_id: "mcp-client", scope: "openid mcp:read" },
      mcpWrite: { client_id: "mcp-client", scope: "mcp:write" },
      ownScope: { client_id: "mcp-client", scope: ["task:read"] },
      unscoped: { client_id: "mcp-client", scope: "openid" },
      agent: { act: { sub: "agent-1" }, scope: "mcp:read" },
      support: { act: { sub: "staff-1", kind: "support" } },
    } as const;
    const answers: Record<string, Answer> = {};
    for (const [name, claims] of Object.entries(tokens)) {
      answers[name] = await answer(claims);
    }
    expect(answers).toEqual({
      user: {
        moduleRead: true,
        moduleUpdate: true,
        rowsRead: 1,
        rowsUpdated: 1,
      },
      mcpRead: {
        moduleRead: true,
        moduleUpdate: false,
        rowsRead: 1,
        rowsUpdated: 0,
      },
      mcpWrite: {
        moduleRead: true,
        moduleUpdate: true,
        rowsRead: 1,
        rowsUpdated: 1,
      },
      ownScope: {
        moduleRead: true,
        moduleUpdate: false,
        rowsRead: 1,
        rowsUpdated: 0,
      },
      unscoped: {
        moduleRead: false,
        moduleUpdate: false,
        rowsRead: 0,
        rowsUpdated: 0,
      },
      agent: {
        moduleRead: true,
        moduleUpdate: false,
        rowsRead: 1,
        rowsUpdated: 0,
      },
      support: {
        moduleRead: true,
        moduleUpdate: true,
        rowsRead: 1,
        rowsUpdated: 1,
      },
    });
  });
});
