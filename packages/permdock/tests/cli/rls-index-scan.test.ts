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
  it("skips an expression-first index, an unbalanced group and unquoted odd text", () => {
    expect(
      indexKeysFromSql(`
create index on a ((lower(name)), id);
create index on b (id;
create index on c ("it""s" , 'a)b');
create table d (note text default 'x(y', id uuid primary key, unique ((lower(note))));
create table e (id uuid unique, unique ("co""de");
create table f (name text default 'a;
`),
    ).toStrictEqual({ "public.c": [['it"s']], "public.d": [["id"]] });
  });
});

describe("indexKeysFromSql", () => {
  it("reads indexes, constraints and keys, cut at the first expression", () => {
    expect(indexKeysFromSql(SQL)).toStrictEqual({
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

  it("drops the targets an index leads with and keeps the rest", () => {
    const keys = indexKeysFromSql(SQL);
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

describe("tablesFromSql", () => {
  it("lists created tables, qualified, without temporary ones or comments", () => {
    expect([
      ...tablesFromSql(`
-- create table public.commented (id int);
create table public.organization_members (id uuid);
CREATE UNLOGGED TABLE IF NOT EXISTS app."Jobs" (id uuid);
create table audit_events partition of events for values in ('audit');
create temp table scratch (id int);
`),
    ]).toStrictEqual([
      "public.organization_members",
      "app.Jobs",
      "public.audit_events",
    ]);
  });
});

describe("indexKeysFromProject", () => {
  const TMP = path.join(import.meta.dirname, "../../tmp");
  mkdirSync(TMP, { recursive: true });
  const cwd = mkdtempSync(path.join(TMP, "index-scan-"));
  afterAll(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  it("reads the migrations and ignores the indexes PermDock generated", () => {
    const dir = path.join(cwd, "supabase/migrations");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, "20260101000000_init.sql"),
      `create index if not exists "permdock_jobs_org_id_idx" on "public"."jobs" ("org_id");
create index jobs_owner on public.jobs (owner_id);
CREATE INDEX permdock_notes_user_id_idx ON public.notes USING btree (user_id);
`,
    );
    expect(indexKeysFromProject(cwd)).toStrictEqual({
      "public.jobs": [["owner_id"]],
    });
  });
});
