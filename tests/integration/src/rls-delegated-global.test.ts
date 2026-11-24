import { PGlite } from "@electric-sql/pglite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { rlsGenerate } from "./support/rls.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "../fixtures/delegated-global");

const OWNER = "00000000-0000-4000-8000-0000000000c1";

const SETUP = `
create role authenticated nologin;
create role anon nologin;
create role supabase_auth_admin nologin;
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
insert into auth.users (id) values ('${OWNER}');
create table public.organization_members (
  organization_id text not null,
  user_id uuid not null references auth.users on delete cascade,
  role text not null
);

`;

const USER = { sub: OWNER, role: "authenticated", session_id: "s1" };

const TOKENS = {
  session: USER,
  apiKey: { ...USER, api_key: { id: "k1", scopes: ["report.read"] } },
  oauthClient: { ...USER, client_id: "mcp-client", scope: "openid email" },
  agent: { ...USER, act: { sub: "agent-1", kind: "agent" } },
  support: { ...USER, act: { sub: "staff-1", kind: "support" } },
} as const;

describe("global grants for delegated tokens without token caps", () => {
  const dir = mkdtempSync(join(tmpdir(), "permdock-delegated-global-"));
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
    await lite.exec(
      `insert into permdock.user_roles (user_id, role) values ('${OWNER}', 'admin');`,
    );
  }, 120_000);

  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await lite?.close();
  });

  const has = async (
    claims: Readonly<Record<string, unknown>>,
    query: string,
  ): Promise<boolean | undefined> => {
    if (lite === undefined) {
      throw new Error("PermDock: PGlite did not start");
    }
    await lite.exec("begin");
    try {
      await lite.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify(claims),
      ]);
      const result = await lite.query<{ readonly v: boolean }>(query);
      return result.rows[0]?.v;
    } finally {
      await lite.exec("rollback");
    }
  };

  it("holds the global grant only for the user's own session", async () => {
    const results: Record<string, boolean | undefined> = {};
    for (const [name, claims] of Object.entries(TOKENS)) {
      results[name] = await has(
        claims,
        "select permdock.permdock_has_permission('report.read') as v",
      );
    }
    expect(results).toStrictEqual({
      session: true,
      apiKey: false,
      oauthClient: false,
      agent: false,
      support: false,
    });
  });

  it("keeps the session's memo apart from a delegated token in one transaction", async () => {
    if (lite === undefined) {
      throw new Error("PermDock: PGlite did not start");
    }
    await lite.exec("begin");
    try {
      const read = async (claims: Readonly<Record<string, unknown>>) => {
        await lite?.query("select set_config('request.jwt.claims', $1, true)", [
          JSON.stringify(claims),
        ]);
        const result = await lite?.query<{ readonly v: boolean }>(
          "select permdock.permdock_has_permission('report.read') as v",
        );
        return result?.rows[0]?.v;
      };
      expect(await read(TOKENS.session)).toBe(true);
      expect(await read(TOKENS.oauthClient)).toBe(false);
      expect(await read(TOKENS.session)).toBe(true);
    } finally {
      await lite.exec("rollback");
    }
  });

  it("answers for the named user in permdock_has_for whatever the token", async () => {
    expect(
      await has(
        TOKENS.oauthClient,
        `select permdock.permdock_has_for('${OWNER}', 'report.read') as v`,
      ),
    ).toBe(true);
  });
});
