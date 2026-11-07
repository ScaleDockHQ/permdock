import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { DoctorFinding } from "../../src/cli/shared/doctor-types.ts";
import type { PermDockConfig } from "../../src/cli/types.ts";

import {
  pd046,
  pd047,
  pd048,
  pd049,
  pd050,
  pd051,
  pd052,
  pd053,
  pd062,
  pd063,
  pd088,
  pd089,
  pd090,
  pd093,
} from "../../src/cli/doctor/sql.ts";
import { sqlStatements } from "../../src/cli/sql/statements.ts";
import { project, removeProjects } from "./doctor-kit.ts";

describe("doctor sql", () => {
  afterAll(removeProjects);

  const config: PermDockConfig = {};
  const MIGRATION = "supabase/migrations/20260101000000_app.sql";

  function messages(findings: readonly DoctorFinding[]): readonly string[] {
    return findings.map((item) => item.message);
  }

  const migration = (sql: string): string => project({ [MIGRATION]: sql });

  describe(sqlStatements, () => {
    it("splits outside strings and dollar-quoted bodies, and keeps first lines", () => {
      expect(
        sqlStatements(
          `-- a; comment\nselect ';';\ncreate function f() returns int language sql as $body$ select 1; $body$;\n\n/* x; */ select 2`,
        ),
      ).toStrictEqual([
        { line: 2, text: "select ';'" },
        {
          line: 3,
          text: "create function f() returns int language sql as $body$ select 1; $body$",
        },
        { line: 5, text: "select 2" },
      ]);
    });
  });

  describe("PD046 helper schema in the Data API", () => {
    it("warns when [api] schemas lists the helper schema, and by default for public", () => {
      const exposed = project({
        "supabase/config.toml": '[api]\nschemas = ["public", "permdock"]\n',
      });
      expect(messages(pd046(exposed, config))).toStrictEqual([
        "the PermDock helper schema permdock is in [api] schemas in supabase/config.toml, so the Data API serves its security definer helpers as RPCs",
      ]);
      const defaults = project({ "supabase/config.toml": "[auth]\n" });
      expect(pd046(defaults, config)).toStrictEqual([]);
      expect(pd046(defaults, { rls: { schema: "public" } })).toHaveLength(1);
      expect(pd046(project({}), { rls: { schema: "public" } })).toStrictEqual(
        [],
      );
    });
  });

  describe("PD047 user_metadata", () => {
    it("reports each read with its line", () => {
      const cwd = migration(
        `create policy p on public.doc for select\n  using ((auth.jwt() -> 'user_metadata' ->> 'org') = org_id::text);\n-- raw_user_meta_data in a comment\nselect 1;`,
      );
      expect(messages(pd047(cwd, config))).toStrictEqual([
        `${MIGRATION}:2 reads user_metadata, which a user can set for themselves`,
      ]);
    });

    it("skips a project that is not on Supabase", () => {
      const cwd = project({ "migrations/1.sql": "select raw_user_meta_data;" });
      expect(pd047(cwd, config)).toStrictEqual([]);
      expect(pd047(cwd, { rls: { dialect: "supabase" } })).toHaveLength(1);
    });
  });

  describe("PD048 and PD049 functions", () => {
    const sql = `create function public.bare() returns int language sql as $$ select 1 $$;
create or replace function public.leaky() returns int
language sql security definer
as $$ set search_path = ''; select 1 $$;
create function app.safe() returns int language sql security definer set search_path = '' as $$ select 1 $$;
revoke execute on function app.safe() from public;
create function public.later() returns int language sql security definer as $$ select 1 $$;
alter function public.later() set search_path = '';
revoke all on function public.later() from public, anon;
create function public.audit() returns trigger language plpgsql security definer set search_path = '' as $$ begin return null; end $$;`;

    it("PD048 reports functions whose header sets no search_path", () => {
      expect(messages(pd048(migration(sql), config))).toStrictEqual([
        `${MIGRATION}:1 function public.bare sets no search_path`,
        `${MIGRATION}:2 security definer function public.leaky sets no search_path, so a caller can shadow what it reads with their own objects`,
      ]);
    });

    it("PD049 reports definer functions public or anon may execute", () => {
      expect(messages(pd049(migration(sql), config))).toStrictEqual([
        `${MIGRATION}:2 security definer function public.leaky can be executed by public and anon`,
      ]);
      const schemaWide = migration(
        `${sql}\nalter default privileges in schema public revoke execute on functions from public, anon;\nrevoke execute on all functions in schema public from public, anon;`,
      );
      expect(pd049(schemaWide, config)).toStrictEqual([]);
    });

    it("PD049 reports a hook claim function any client role may execute", () => {
      const hook: PermDockConfig = {
        supabase: {
          hook: {
            memberships: [],
            claims: { features: "billing.feature_claims" },
            before: "auth_checks.require_sso",
          },
        },
      };
      const create = `create function billing.feature_claims(uid uuid) returns jsonb language sql stable set search_path = '' as $$ select '{}'::jsonb $$;
create function auth_checks.require_sso(event jsonb) returns jsonb language sql security definer set search_path = '' as $$ select event $$;
revoke execute on function auth_checks.require_sso(jsonb) from public, anon;`;
      const findings = pd049(migration(create), hook);
      expect(messages(findings)).toStrictEqual([
        `${MIGRATION}:1 hook claim function billing.feature_claims returns any user's claims and can be executed by public and anon and authenticated`,
        `${MIGRATION}:2 hook claim function auth_checks.require_sso returns any user's claims and can be executed by authenticated`,
      ]);
      expect(findings[0]?.fix).toBe(
        "regenerate the hook (permdock rls generate), which revokes it, or add revoke all on function billing.feature_claims(uuid) from public, anon, authenticated;",
      );
      const revoked = migration(
        `${create}\nrevoke all on function billing.feature_claims(uuid) from public, anon, authenticated;\nrevoke all on function auth_checks.require_sso(jsonb) from public, anon, authenticated;`,
      );
      expect(pd049(revoked, hook)).toStrictEqual([]);
    });
  });

  describe("PD050 tables without row level security", () => {
    it("errors on a public table until RLS is enabled, and ignores other schemas and dropped tables", () => {
      const cwd = migration(`create table public.doc (id uuid primary key);
create table if not exists "Notes" (id uuid primary key);
alter table only "Notes" enable row level security;
create table private.audit (id bigint);
create table scratch (id int);
drop table if exists scratch;`);
      expect(pd050(cwd, config)).toStrictEqual([
        {
          code: "PD050",
          severity: "error",
          message: `${MIGRATION}:1 creates public.doc without row level security, so the Data API serves every row to anon and authenticated`,
          fix: "alter table public.doc enable row level security; permdock rls generate writes its policies",
        },
      ]);
    });
  });

  describe("PD051 and PD052 policies", () => {
    const sql = `create policy "own rows" on public.doc for select to authenticated
  using (owner_id = auth.uid() and (auth.jwt() ->> 'aal') = 'aal2');
create policy wrapped on doc for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));
create policy loose on doc for update to authenticated
  using (owner_id = (select auth.uid()));`;

    it("PD051 reports bare auth.uid() and auth.jwt() once per policy", () => {
      expect(messages(pd051(migration(sql), config))).toStrictEqual([
        `${MIGRATION}:1 policy own rows on public.doc calls auth.uid() and auth.jwt() once per row`,
      ]);
    });

    it("PD052 reports an update policy without with check", () => {
      expect(messages(pd052(migration(sql), config))).toStrictEqual([
        `${MIGRATION}:6 update policy loose on public.doc has no with check, so Postgres checks the new row against using alone`,
      ]);
    });
  });

  describe("PD053 unindexed foreign keys", () => {
    it("reports a foreign key until an index, primary key or unique constraint starts with it", () => {
      const cwd = migration(`create table public.members (
  user_id uuid not null references auth.users on delete cascade,
  org_id uuid not null,
  team_id uuid,
  primary key (org_id, user_id),
  constraint members_org foreign key (org_id) references public.orgs (id),
  foreign key (team_id) references public.teams (id)
);
create index members_user on public.members using btree (user_id);
alter table public.notes add constraint notes_author foreign key (author_id) references auth.users (id);`);
      expect(messages(pd053(cwd, config))).toStrictEqual([
        `${MIGRATION}:1 public.members.team_id is a foreign key no index starts with, so policies that join on it and deletes of the referenced row scan public.members`,
        `${MIGRATION}:10 public.notes.author_id is a foreign key no index starts with, so policies that join on it and deletes of the referenced row scan public.notes`,
      ]);
    });

    it("counts a unique constraint added later as the index", () => {
      const cwd =
        migration(`alter table public.notes add constraint notes_author foreign key (author_id) references auth.users (id);
alter table only public.notes add constraint notes_author_key unique (author_id, id);`);
      expect(pd053(cwd, config)).toStrictEqual([]);
    });
  });

  describe("PD062 legacy request.jwt.claim settings", () => {
    it("reports each legacy claim a statement uses, with a fix per claim", () => {
      const cwd = migration(
        [
          "create policy own on public.notes for select to authenticated using (owner = current_setting('request.jwt.claim.sub', true)::uuid);",
          "select set_config('request.jwt.claim.role', 'authenticated', true), set_config('request.jwt.claims', '{}', true);",
          "select current_setting('request.jwt.claims', true);",
        ].join("\n"),
      );
      const findings = pd062(cwd, config);
      expect(messages(findings)).toStrictEqual([
        `${MIGRATION}:1 uses the legacy request.jwt.claim.sub setting, which PostgREST 12 and PermDock's withSubject no longer set, so it reads null`,
        `${MIGRATION}:2 uses the legacy request.jwt.claim.role setting, which PostgREST 12 and PermDock's withSubject no longer set, so it reads null`,
      ]);
      expect(findings[0]?.fix).toMatch(/permdock_user_id\(\)/u);
      expect(findings[1]?.fix).toMatch(/auth\.jwt\(\)\) ->> 'role'/u);
    });

    it("judges a function by its last definition", () => {
      const old =
        "create or replace function permdock.uid() returns uuid language sql as $$ select current_setting('request.jwt.claim.sub', true)::uuid $$;";
      const replaced =
        "create or replace function permdock.uid() returns uuid language sql as $$ select (select auth.uid()) $$;";
      expect(pd062(migration(`${old}\n${replaced}`), config)).toStrictEqual([]);
      expect(
        messages(pd062(migration(`${replaced}\n${old}`), config)),
      ).toStrictEqual([
        `${MIGRATION}:2 uses the legacy request.jwt.claim.sub setting, which PostgREST 12 and PermDock's withSubject no longer set, so it reads null`,
      ]);
    });
  });

  describe("PD063 statements supautils rejects", () => {
    it("reports each rejected statement as an error with its line", () => {
      const cwd = migration(
        [
          "alter role authenticated set statement_timeout = '8s';",
          "create role app_reader nologin;",
          "grant app_reader to authenticator;",
          "alter role anon nologin;",
          "grant authenticator to app_reader;",
        ].join("\n"),
      );
      const findings = pd063(cwd, config);
      expect(messages(findings)).toStrictEqual([
        `${MIGRATION}:4 changes the reserved role anon, which supautils rejects for the postgres role on Supabase`,
        `${MIGRATION}:5 grants membership in the reserved role authenticator, which supautils rejects for the postgres role on Supabase`,
      ]);
      expect(findings.map((item) => item.severity)).toStrictEqual([
        "error",
        "error",
      ]);
    });

    it("skips a project that is not on Supabase", () => {
      const cwd = project({ "migrations/0001.sql": "drop role anon;" });
      expect(
        pd063(cwd, { doctor: { migrations: ["migrations"] } }),
      ).toStrictEqual([]);
    });
  });

  describe("PD088 text cast on a row helper", () => {
    it("reports a cast on the column and on the call, outside functions", () => {
      const cwd = migration(
        [
          `create policy a on doc using (id::text in (select "permdock".permitted_doc_rows('doc.read')));`,
          `create policy b on doc using (id in (select "permdock".permitted_doc_rows('doc.read')::text));`,
          `create policy c on doc using ("permdock".permitted_doc_row(id::text, 'doc.read'));`,
          `create policy d on doc using (id in (select "permdock".permitted_doc_rows('doc.read')));`,
          `create function f() returns void language sql as $$ select id::text in (select permitted_doc_rows('x')) $$;`,
        ].join("\n"),
      );
      expect(
        messages(pd088(cwd, { rls: { dialect: "supabase" } })),
      ).toStrictEqual([
        `${MIGRATION}:1 casts to text around a permitted_*_rows or can_<resource> call`,
        `${MIGRATION}:2 casts to text around a permitted_*_rows or can_<resource> call`,
        `${MIGRATION}:3 casts to text around a permitted_*_rows or can_<resource> call`,
      ]);
    });

    it("skips text ids", () => {
      const cwd = migration(
        `create policy a on doc using (id::text in (select permitted_doc_rows('doc.read')));`,
      );
      expect(pd088(cwd, { rls: { dialect: "neon" } })).toStrictEqual([]);
      expect(pd088(cwd, { rls: { idTypes: { "*": "text" } } })).toStrictEqual(
        [],
      );
    });
  });

  describe("PD089 one id against the row set", () => {
    it("reports a bound id and not a column", () => {
      const cwd = migration(
        [
          `create policy a on doc using ($1 in (select permitted_doc_rows('doc.read')));`,
          `create policy b on doc using (new.doc_id in (select "permdock".permitted_doc_rows('doc.read')));`,
          `create policy c on doc using (id in (select permitted_doc_rows('doc.read')));`,
        ].join("\n"),
      );
      expect(messages(pd089(cwd, config))).toStrictEqual([
        `${MIGRATION}:1 tests one id against the whole permitted_*_rows set`,
        `${MIGRATION}:2 tests one id against the whole permitted_*_rows set`,
      ]);
    });
  });

  describe("PD089 function bodies and the any(array()) form", () => {
    it("reports a hand-written function and an = any(array(...)) test, not a generated helper", () => {
      const cwd = migration(
        [
          `create function public.may_read(p_id uuid) returns boolean language sql stable as $$ select p_id in (select permdock.permitted_doc_rows('doc.read')) $$;`,
          `create policy d on doc using (new.doc_id = any(array(select permdock.permitted_doc_rows('doc.read'))));`,
          `create function permdock.permitted_doc_row(p_id uuid, p_permission text) returns boolean language sql as $$ select p_id in (select permdock.permitted_doc_rows(p_permission)) $$;`,
          `create function public.fine(p_id uuid) returns boolean language sql as $$ select permdock.permitted_doc_row(p_id, 'doc.read') $$;`,
        ].join("\n"),
      );
      expect(messages(pd089(cwd, config))).toStrictEqual([
        `${MIGRATION}:1 tests one id against the whole permitted_*_rows set`,
        `${MIGRATION}:2 tests one id against the whole permitted_*_rows set`,
      ]);
    });
  });

  describe("PD090 repeated actor guard", () => {
    it("reports a hand-written policy that calls the guard where the generated one applies", () => {
      const cwd = migration(
        [
          `create policy "public_quotes_update_read_only_actors" on "public"."quotes" as restrictive for update to authenticated using ((select permdock_actor_may_write()));`,
          `create policy quotes_write on public.quotes for update to authenticated using ((select permdock_actor_may_write()) and true);`,
          `create policy quotes_insert on public.quotes for insert to authenticated with check ((select permdock_actor_may_write()));`,
          `create policy quotes_plain on public.quotes for update to authenticated using (true);`,
        ].join("\n"),
      );
      expect(messages(pd090(cwd, config))).toStrictEqual([
        `${MIGRATION}:2 policy quotes_write on public.quotes repeats the permdock_actor_may_write() guard of the generated read-only actor policy`,
      ]);
    });
  });

  describe("PD093 own_subject", () => {
    it("reports a migration that defines own_subject()", () => {
      const cwd = migration(
        [
          `select 1;`,
          `create or replace function public.own_subject() returns jsonb language sql as $$ select null::jsonb $$;`,
          `create function public.permdock_subject() returns jsonb language sql as $$ select null::jsonb $$;`,
        ].join("\n"),
      );
      expect(messages(pd093(cwd, config))).toStrictEqual([
        `${MIGRATION}:2 defines own_subject(), which permdock_subject() from the hook migration already is`,
      ]);
    });
  });

  describe("PD090 declarative schemas and rls.out", () => {
    const generated = `create policy "public_quotes_update_read_only_actors" on "public"."quotes" as restrictive for update to authenticated using ((select "permdock".permdock_actor_may_write()));`;

    it("reads supabase/schemas when doctor.migrations lists another folder", () => {
      const cwd = project({
        "supabase/schemas/permdock.sql": generated,
        "supabase/schemas/app.sql": `create policy quotes_write on public.quotes for update to authenticated using ((select permdock_actor_may_write()));`,
        "supabase/migrations/20260101000000_x.sql": "select 1;",
      });
      expect(
        messages(
          pd090(cwd, { doctor: { migrations: ["supabase/migrations"] } }),
        ),
      ).toStrictEqual([
        `supabase/schemas/app.sql:1 policy quotes_write on public.quotes repeats the permdock_actor_may_write() guard of the generated read-only actor policy`,
      ]);
    });

    it("reads rls.out and matches the guard 0.24 inlined", () => {
      const cwd = project({
        "generated/rls.sql": generated,
        [MIGRATION]: `create policy "quotes_write" on "public"."quotes" for update to authenticated using (not coalesce((((select auth.jwt()) -> 'act') ->> 'kind') = 'support', false) or coalesce((((select auth.jwt()) -> 'act') ->> 'read_only') = 'false', false));`,
      });
      expect(
        messages(pd090(cwd, { rls: { out: "generated/rls.sql" } })),
      ).toHaveLength(1);
    });
  });

  describe("PD090 policy commands", () => {
    it("treats a policy for all or without a command as every write, and skips other statements", () => {
      const cwd = migration(
        [
          `select 1;`,
          `create policy "public_quotes_delete_read_only_actors" on "public"."quotes" as restrictive for delete to authenticated using ((select permdock_actor_may_write()));`,
          `create policy quotes_all on public.quotes for all to authenticated using ((select permdock_actor_may_write()));`,
          `create policy quotes_any on public.quotes using ((select permdock_actor_may_write()));`,
        ].join("\n"),
      );
      expect(messages(pd090(cwd, config))).toStrictEqual([
        `${MIGRATION}:3 policy quotes_all on public.quotes repeats the permdock_actor_may_write() guard of the generated read-only actor policy`,
        `${MIGRATION}:4 policy quotes_any on public.quotes repeats the permdock_actor_may_write() guard of the generated read-only actor policy`,
      ]);
    });
  });

  describe("the generated RLS", () => {
    it("passes every SQL check", () => {
      const golden = readFileSync(
        path.join(
          import.meta.dirname,
          "fixtures/golden/rbac-supabase-database.sql",
        ),
        "utf8",
      );
      const cwd = migration(golden);
      const findings = [
        pd047,
        pd048,
        pd049,
        pd050,
        pd051,
        pd052,
        pd053,
        pd062,
        pd063,
      ].flatMap((check) => check(cwd, config));
      expect(findings).toStrictEqual([]);
    });
  });
});
