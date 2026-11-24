import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import {
  indexKeysFromProject,
  indexKeysFromSql,
  tablesFromSql,
  withoutServedTargets,
} from "../../src/cli/rls/index-scan.ts";

const SQL = `
-- create index on public.ignored (x);
create table public.organization_members (
  id uuid primary key,
  organization_id uuid not null,
  user_id uuid not null,
  role_id uuid not null,
  constraint organization_members_unique unique (user_id, role_id, organization_id)
);
create unique index concurrently if not exists "jobs_owner" on only app.jobs using btree ("owner_id" desc, lower(name));
create index on jobs (org_id, (created_at::date));
alter table public.teams add constraint teams_pkey primary key (id);
create table other (code text unique, check (code <> ''), foreign key (code) references x(c));
`;

describe("indexKeysFromSql edge cases", () => {
  it("skips an expression-first index and a statement Postgres rejects", async () => {
    expect(
      await indexKeysFromSql(`
create index on a ((lower(name)), id);
create index on b (id;
create index on c ("it""s", (lower(x)));
create table d (note text default 'x(y', id uuid primary key);
create table f (name text default 'a;
`),
    ).toStrictEqual({ "public.c": [['it"s']], "public.d": [["id"]] });
  });

  it("keeps a key after a -- inside a string and ignores SQL in a function body", async () => {
    expect(
      await indexKeysFromSql(`
create table g (note text default '--x', id uuid primary key);
create function f() returns void language plpgsql as $$
begin
  execute 'create index on fake (x)';
end
$$;
create index on "S".t (k);
`),
    ).toStrictEqual({ "public.g": [["id"]], "S.t": [["k"]] });
  });
});

describe(indexKeysFromSql, () => {
  it("reads indexes, constraints and keys, cut at the first expression", async () => {
    expect(await indexKeysFromSql(SQL)).toStrictEqual({
      "public.organization_members": [
        ["id"],
        ["user_id", "role_id", "organization_id"],
      ],
      "app.jobs": [["owner_id"]],
      "public.jobs": [["org_id"]],
      "public.teams": [["id"]],
      "public.other": [["code"]],
    });
  });

  it("drops the targets an index leads with and keeps the rest", async () => {
    const keys = await indexKeysFromSql(SQL);
    expect(
      withoutServedTargets(
        [
          { table: "public.organization_members", columns: ["user_id"] },
          {
            table: "public.organization_members",
            columns: ["user_id", "organization_id"],
          },
          { table: "public.jobs", columns: ["owner_id"] },
        ],
        keys,
      ),
    ).toStrictEqual([
      {
        table: "public.organization_members",
        columns: ["user_id", "organization_id"],
      },
      { table: "public.jobs", columns: ["owner_id"] },
    ]);
  });
});

describe(tablesFromSql, () => {
  it("lists created tables, qualified, without temporary ones or comments", async () => {
    expect([
      ...(await tablesFromSql(`
-- create table public.commented (id int);
create table public.organization_members (id uuid);
CREATE UNLOGGED TABLE IF NOT EXISTS app."Jobs" (id uuid);
create table audit_events partition of events for values in ('audit');
create temp table scratch (id int);
create function f() returns void language sql as $$ create table public.body_only (id int) $$;
`)),
    ]).toStrictEqual([
      "public.organization_members",
      "app.Jobs",
      "public.audit_events",
    ]);
  });
});

describe(indexKeysFromProject, () => {
  const TMP = path.join(import.meta.dirname, "../../tmp");
  mkdirSync(TMP, { recursive: true });
  const cwd = mkdtempSync(path.join(TMP, "index-scan-"));

  afterAll(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("reads the migrations and ignores the indexes PermDock generated", async () => {
    const dir = path.join(cwd, "supabase/migrations");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "20260101000000_init.sql"),
      `create index if not exists "permdock_jobs_org_id_idx" on "public"."jobs" ("org_id");
create index jobs_owner on public.jobs (owner_id);
CREATE INDEX permdock_notes_user_id_idx ON public.notes USING btree (user_id);
`,
    );
    expect(await indexKeysFromProject(cwd)).toStrictEqual({
      "public.jobs": [["owner_id"]],
    });
  });
});
