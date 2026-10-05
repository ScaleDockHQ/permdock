import { createClient, sql } from "@pgkit/client";
import { Migration } from "@pgkit/migra";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "permdock/cli";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Postgres } from "./support/postgres.ts";

import { startPostgres } from "./support/postgres.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

const ROLES = `
create role authenticated nologin;
create role anon nologin;
create role supabase_auth_admin nologin;
`;

const AUTH = `
alter default privileges grant all on tables to anon, authenticated;
create schema auth;
create table auth.users (id uuid primary key, raw_app_meta_data jsonb not null default '{}');
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;
`;

const CUSTOM_ROLES = `${AUTH}
create table public.organization_members (
  organization_id text not null,
  user_id uuid not null references auth.users on delete cascade,
  role text not null
);
create table public.team_members (
  team_id text not null,
  organization_id text not null,
  user_id uuid not null references auth.users on delete cascade,
  role text not null
);
`;

const CENTRAKIT = `${AUTH}
create table public.organizations (id uuid primary key, disabled_at timestamptz);
create table public.profiles (user_id uuid primary key, disabled_at timestamptz);
create type public.scope_type as enum ('system', 'organization', 'user', 'team');
create table public.roles (
  id uuid primary key,
  scope public.scope_type not null,
  key text not null,
  name text not null,
  system boolean not null default false,
  organization_id uuid references public.organizations (id) on delete cascade
);
alter table public.roles enable row level security;
create table public.user_roles (user_id uuid not null, role_id uuid not null references public.roles (id));
alter table public.user_roles enable row level security;
create table public.organization_users (
  user_id uuid not null references auth.users (id) on delete cascade,
  organization_id uuid not null references public.organizations (id) on delete cascade,
  role_id uuid not null references public.roles (id),
  unique (user_id, organization_id)
);
alter table public.organization_users enable row level security;
create table public.contact_profiles (
  id uuid primary key,
  user_id uuid unique references auth.users (id) on delete set null
);
alter table public.contact_profiles enable row level security;
create table public.customer_contacts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  customer_id uuid not null,
  contact_profile_id uuid not null references public.contact_profiles (id) on delete cascade
);
alter table public.customer_contacts enable row level security;
`;

async function generate(
  fixture: string,
  split: string,
): Promise<{ readonly schema: string; readonly grants: string }> {
  const dir = mkdtempSync(join(tmpdir(), "permdock-db-diff-"));
  try {
    const result = await run(
      [
        "rls",
        "generate",
        "--target",
        "sql",
        "--split",
        split,
        "--out",
        join(dir, "{part}.sql"),
        "--grants-out",
        join(dir, "grants.sql"),
      ],
      { cwd: join(HERE, "../fixtures", fixture) },
    );
    if (result.code !== 0) {
      throw new Error(`rls generate: ${result.stdout}${result.stderr}`);
    }
    return {
      schema: split
        .split(",")
        .map((part) => readFileSync(join(dir, `${part}.sql`), "utf8"))
        .join("\n"),
      grants: readFileSync(join(dir, "grants.sql"), "utf8"),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("supabase db diff over rls generate --grants-out", () => {
  let db: Postgres | undefined;
  let databases = 0;

  beforeAll(async () => {
    db = await startPostgres([ROLES]);
  }, 180_000);

  afterAll(async () => {
    await db?.stop();
  });

  const database = async (statements: readonly string[]): Promise<string> => {
    if (db === undefined) {
      throw new Error("PermDock: Postgres was not started");
    }
    databases += 1;
    const name = `diff_${String(databases)}`;
    await db.admin.query(`create database ${name}`);
    const uri = new URL(db.uri);
    uri.pathname = `/${name}`;
    const client = new Client({ connectionString: uri.toString() });
    await client.connect();
    try {
      await client.query(statements.join(";\n"));
    } finally {
      await client.end();
    }
    return uri.toString();
  };

  const diff = async (from: string, to: string): Promise<string> => {
    const base = createClient(from);
    const head = createClient(to);
    try {
      await base.query(sql`set search_path = ''`);
      await head.query(sql`set search_path = ''`);
      const migration = await Migration.create(base, head, {
        exclude_schema: ["auth"],
        ignore_extension_versions: true,
      });
      migration.set_safety(false);
      migration.add_all_changes(true);
      return migration.sql.trim();
    } finally {
      await base.end();
      await head.end();
    }
  };

  for (const [fixture, setup, split] of [
    ["rls-custom-roles", CUSTOM_ROLES, "helpers"],
    ["centrakit-roles", CENTRAKIT, "helpers,hook"],
  ] as const) {
    it(`finds nothing to change between the migrations and the ${split} schema (${fixture})`, async () => {
      const { schema, grants } = await generate(fixture, split);
      const migrated = await database([setup, schema, grants]);
      const declared = await database([setup, schema]);
      expect(await diff(migrated, declared)).toBe("");
      expect(await diff(declared, migrated)).toBe("");
    });
  }
});
