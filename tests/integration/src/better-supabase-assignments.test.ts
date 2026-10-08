import { PGlite } from "@electric-sql/pglite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { authorizationProvider } from "permdock/better-supabase";
import { run } from "permdock/cli";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "../fixtures/assignments-provider");

const ADMIN = "00000000-0000-4000-8000-0000000000f2";
const MEMBER = "00000000-0000-4000-8000-0000000000f3";

const SETUP = `
create role authenticated nologin;
create role anon nologin;
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
insert into auth.users (id) values ('${ADMIN}'), ('${MEMBER}');
create table public.organization_members (
  organization_id text not null,
  user_id uuid not null references auth.users on delete cascade,
  role text not null
);
insert into public.organization_members values
  ('acme', '${ADMIN}', 'admin'),
  ('acme', '${MEMBER}', 'member');
create table public.invitations (organization_id text, email text not null, role text not null);
create table public.job (id text primary key, "orgId" text not null);
`;

const SEED = `
select permdock.permdock_trusted_replace_custom_role_grants('acme', 'tenant', null, 'reader', array['job.read'], array[]::text[], array[]::text[]);
select permdock.permdock_trusted_replace_custom_role_grants('acme', 'tenant', null, 'editor', array['job.update'], array[]::text[], array[]::text[]);
`;

describe("authorizationProvider canAssign with custom roles", () => {
  const dir = mkdtempSync(join(tmpdir(), "permdock-provider-assign-"));
  let lite: PGlite | undefined;
  let manifest = "";

  beforeAll(async () => {
    const out = join(dir, "rls.sql");
    const generated = await run(
      ["rls", "generate", "--target", "sql", "--out", out],
      { cwd: FIXTURE },
    );
    if (generated.code !== 0) {
      throw new Error(`rls generate: ${generated.stdout}`);
    }
    const inspected = await run(["supabase", "inspect", "--json"], {
      cwd: FIXTURE,
    });
    if (inspected.code !== 0) {
      throw new Error(`supabase inspect: ${inspected.stdout}`);
    }
    manifest = inspected.stdout;
    lite = new PGlite();
    await lite.exec(SETUP);
    await lite.exec(readFileSync(out, "utf8"));
    await lite.exec(SEED);
  }, 120_000);

  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await lite?.close();
  });

  const database = (): PGlite => {
    if (lite === undefined) {
      throw new Error("PermDock: PGlite did not start");
    }
    return lite;
  };

  const askAs = async (user: string, sql: string): Promise<unknown> => {
    const db = database();
    await db.exec("begin; set local role authenticated;");
    try {
      await db.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: user, role: "authenticated" }),
      ]);
      return (await db.query<{ ok: unknown }>(`select ${sql} as ok`)).rows[0]
        ?.ok;
    } finally {
      await db.exec("rollback");
    }
  };

  const ask = async (sql: string): Promise<unknown> =>
    (await database().query<{ ok: unknown }>(`select ${sql} as ok`)).rows[0]
      ?.ok;

  it("answers declared and custom roles through the templates", async () => {
    const provider = authorizationProvider({ manifest });
    const { canAssign, canAssignFor } = provider.functions;
    if (canAssign === undefined || canAssignFor === undefined) {
      throw new Error("PermDock: the provider has no canAssign templates");
    }
    const fill = (template: string, role: string, user = ""): string =>
      template
        .replaceAll("{scope}", provider.tenantScope)
        .replaceAll("{tenant}", "'acme'")
        .replaceAll("{role}", `'${role}'`)
        .replaceAll("{user}", `'${user}'::uuid`);
    const answers: Record<string, unknown> = {};
    for (const role of ["member", "admin", "reader", "editor"]) {
      answers[role] = await askAs(ADMIN, fill(canAssign, role));
      answers[`${role} for`] = await ask(fill(canAssignFor, role, ADMIN));
      answers[`${role} by member`] = await askAs(MEMBER, fill(canAssign, role));
    }
    expect(answers).toEqual({
      member: true,
      "member for": true,
      "member by member": false,
      admin: false,
      "admin for": false,
      "admin by member": false,
      reader: true,
      "reader for": true,
      "reader by member": true,
      editor: false,
      "editor for": false,
      "editor by member": false,
    });
    expect(
      await askAs(ADMIN, "permdock.permdock_can_assign('reader', 'acme')"),
    ).toBe(false);
  });

  it("lists assignment helpers that exist with the listed arguments", async () => {
    const provider = authorizationProvider({ manifest });
    const assigning = (provider.requires ?? []).filter(({ function: fn }) =>
      fn.includes("can_assign"),
    );
    expect(assigning.map(({ function: fn }) => fn)).toEqual([
      "permdock.permdock_can_assign_any",
      "permdock.permdock_can_assign_any_for",
    ]);
    for (const { function: fn, args } of assigning) {
      expect(
        await ask(`to_regprocedure('${fn}(${args ?? ""})') is not null`),
      ).toBe(true);
    }
  });
});
