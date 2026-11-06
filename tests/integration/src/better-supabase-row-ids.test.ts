import { PGlite } from "@electric-sql/pglite";
import { defineConfig, resolveConfig } from "better-supabase/config";
import { moduleLayout, renderBlocks } from "better-supabase/sql";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { authorizationProvider } from "permdock/better-supabase";
import { run } from "permdock/cli";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { hookGenerate, rlsGenerate } from "./support/rls.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "../fixtures/row-ids");

const MEMBER = "00000000-0000-4000-8000-0000000000b1";
const READER = "00000000-0000-4000-8000-0000000000b2";
const SHARED = "00000000-0000-4000-8000-0000000000b3";
const OUTSIDER = "00000000-0000-4000-8000-0000000000b4";
const SHARED_DOC = "00000000-0000-4000-8000-0000000000d1";
const OTHER_DOC = "00000000-0000-4000-8000-0000000000d2";

const SETUP = `
create role authenticated nologin;
create role anon nologin;
create role service_role nologin;
create role supabase_auth_admin nologin;
create schema auth;
create table auth.users (id uuid primary key);
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;
create function auth.role() returns text language sql stable as $$
  select auth.jwt() ->> 'role'
$$;
grant usage on schema auth to authenticated, anon;
grant execute on all functions in schema auth to authenticated, anon;
grant usage on schema public to authenticated, anon;
insert into auth.users (id) values
  ('${MEMBER}'), ('${READER}'), ('${SHARED}'), ('${OUTSIDER}');
create table public.organization_members (
  organization_id text not null,
  user_id uuid not null references auth.users on delete cascade,
  role text not null
);
create table public.doc (
  id uuid primary key,
  "orgId" text not null,
  "ownerId" uuid,
  locked boolean not null default false,
  organization_id text generated always as ("orgId") stored
);
create table public.file (id uuid primary key, "orgId" text not null);
create table public.doc_shares (doc_id uuid not null, user_id uuid not null);
`;

const SEED = `
insert into public.organization_members values
  ('acme', '${MEMBER}', 'member'),
  ('acme', '${READER}', 'reader');
insert into public.doc (id, "orgId") values
  ('${SHARED_DOC}', 'acme'),
  ('${OTHER_DOC}', 'acme');
insert into public.doc_shares values
  ('${SHARED_DOC}', '${READER}'),
  ('${SHARED_DOC}', '${SHARED}');
grant select on public.doc to authenticated;
`;

function blocksSql(manifest: string, dir: string): readonly string[] {
  const provider = authorizationProvider({ manifest, rowHelpers: true });
  const config = resolveConfig(
    defineConfig({
      auth: { authorization: provider },
      blocks: { permissions: { model: "provider" }, subjects: {} },
      subjects: {
        doc: {
          table: "public.doc",
          idType: "uuid",
          tenant: "organization_id",
          permissions: { read: { key: "doc.read", rows: "doc" } },
        },
      },
    }),
    dir,
  );
  const layout = moduleLayout(config, undefined, undefined, undefined, {
    name: provider.name,
    scope: provider.tenantScope,
    scopes: provider.scopes.map((scope) => scope.name),
    idType: "text",
    functions: provider.functions,
  });
  return renderBlocks(["permissions", "subjects"], layout).map(
    (file) => file.contents,
  );
}

describe("better-supabase blocks over uuid PermDock row helpers", () => {
  const dir = mkdtempSync(join(tmpdir(), "permdock-row-ids-"));
  let lite: PGlite | undefined;
  let blocks: readonly string[] = [];

  beforeAll(async () => {
    const sql = join(dir, "rls.sql");
    const manifest = join(dir, "permdock.manifest.json");
    const hook = join(dir, "hook.sql");
    const generated = await rlsGenerate(["--target", "sql", "--out", sql], {
      cwd: FIXTURE,
    });
    if (generated.code !== 0) {
      throw new Error(
        `generate --only rls: ${generated.stdout}${generated.stderr}`,
      );
    }
    const hookResult = await hookGenerate(["--out", hook], { cwd: FIXTURE });
    if (hookResult.code !== 0) {
      throw new Error(
        `generate --only supabaseHook: ${hookResult.stdout}${hookResult.stderr}`,
      );
    }
    for (const argv of [["supabase", "inspect", "--out", manifest]]) {
      const result = await run(argv, { cwd: FIXTURE });
      if (result.code !== 0) {
        throw new Error(`${argv.join(" ")}: ${result.stdout}${result.stderr}`);
      }
    }
    blocks = blocksSql(readFileSync(manifest, "utf8"), dir);
    lite = new PGlite();
    await lite.exec(SETUP);
    await lite.exec(readFileSync(sql, "utf8"));
    await lite.exec(readFileSync(hook, "utf8"));
    for (const contents of blocks) {
      await lite.exec(contents);
    }
    await lite.exec(SEED);
  }, 120_000);

  afterAll(async () => {
    rmSync(dir, { recursive: true, force: true });
    await lite?.close();
  });

  const ask = async (
    sub: string,
    expression: string,
    role = "authenticated",
  ): Promise<unknown> => {
    if (lite === undefined) {
      throw new Error("PermDock: PGlite did not start");
    }
    await lite.exec("begin");
    try {
      await lite.exec(`set local role ${role}`);
      await lite.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub, role }),
      ]);
      return (await lite.query<{ ok: unknown }>(`select ${expression} as ok`))
        .rows[0]?.ok;
    } finally {
      await lite.exec("rollback");
    }
  };

  const canSubject = (id: string): string =>
    `better_supabase.can_subject('doc', '${id}', 'read')`;

  it("calls the row helper with the candidate ids cast to uuid", () => {
    expect(blocks.join("\n")).toContain(
      `permdock.permitted_doc_rows('doc.read', (array[s."id"::text])::uuid[])`,
    );
  });

  it("answers can_subject through the row grants for an allowed and a denied user", async () => {
    expect(await ask(READER, canSubject(SHARED_DOC))).toBe(true);
    expect(await ask(READER, canSubject(OTHER_DOC))).toBe(false);
    expect(await ask(SHARED, canSubject(SHARED_DOC))).toBe(false);
    expect(await ask(OUTSIDER, canSubject(SHARED_DOC))).toBe(false);
    expect(await ask(MEMBER, canSubject(OTHER_DOC))).toBe(true);
  });

  it("answers can_subject_for through the row helper's _for form", async () => {
    expect(
      await ask(
        MEMBER,
        `better_supabase.can_subject_for('${READER}', 'doc', '${SHARED_DOC}', 'read')`,
        "service_role",
      ),
    ).toBe(true);
    expect(
      await ask(
        MEMBER,
        `better_supabase.can_subject_for('${SHARED}', 'doc', '${SHARED_DOC}', 'read')`,
        "service_role",
      ),
    ).toBe(false);
  });
});
