import type { ApprovalStore } from "permdock/approvals";
import type { SupabaseRpcClient } from "permdock/supabase";

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "permdock/cli";
import { supabaseApprovalStore } from "permdock/supabase";
import { testApprovalStore } from "permdock/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Postgres } from "./support/postgres.ts";

import { startPostgres } from "./support/postgres.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

/** An app's approvals table from before PermDock, with a row of its own. */
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
create table public.job (id text primary key, "orgId" text not null, "ownerId" uuid not null);
create table public.approvals (
  id uuid primary key default gen_random_uuid(),
  organization_id text,
  state text not null default 'pending',
  requested_by text,
  approval_count integer not null default 0,
  expires_at timestamptz,
  kind text not null default 'legacy'
);
insert into public.approvals (organization_id, state, requested_by) values ('acme', 'pending', 'legacy-user');
`;

let db: Postgres | undefined;

function rpcClient(): SupabaseRpcClient {
  return {
    schema(name) {
      return {
        async rpc(fn, args) {
          if (db === undefined) {
            throw new Error("PermDock: Postgres was not started");
          }
          const names = Object.keys(args);
          const call = `"${name}"."${fn}"(${names.map((arg, index) => `${arg} => $${String(index + 1)}`).join(", ")})`;
          try {
            const result = await db.admin.query<{ data: unknown }>(
              `select ${call} as data`,
              names.map((arg) => args[arg]),
            );
            const rows = result.rows.map((row) => row.data);
            return {
              data: fn === "permdock_approval_list" ? rows : (rows[0] ?? null),
              error: null,
            };
          } catch (error) {
            return { data: null, error: { message: String(error) } };
          }
        },
      };
    },
  };
}

let current: ApprovalStore = supabaseApprovalStore(rpcClient());
const store: ApprovalStore = {
  create: (request) => current.create(request),
  get: (token) => current.get(token),
  resolve: (token, verdict) => current.resolve(token, verdict),
  consume: (token, now) => current.consume(token, now),
  list: (query) => current.list(query),
  expire: (now) => current.expire(now),
  cancel: (filter, meta) => current.cancel?.(filter, meta) ?? 0,
};

let generated = "";

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "permdock-approval-adopt-"));
  try {
    const out = join(dir, "rls.sql");
    const result = await run(
      ["rls", "generate", "--target", "sql", "--out", out],
      { cwd: join(HERE, "../fixtures/approvals-adopt") },
    );
    if (result.code !== 0) {
      throw new Error(`rls generate: ${result.stdout}`);
    }
    generated = readFileSync(out, "utf8");
    db = await startPostgres([SETUP, generated]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  current = supabaseApprovalStore(rpcClient());
}, 120_000);

afterAll(async () => {
  await db?.stop();
});

describe("supabaseApprovalStore over an adopted approvals table", () => {
  testApprovalStore(store, {
    reopen: () => supabaseApprovalStore(rpcClient()),
  });

  it("adds only its columns, mirrors fields into the app's typed columns and leaves the app's rows alone", async () => {
    expect(generated).not.toContain("approval_requests");
    expect(generated).not.toContain(
      '"public"."approvals" enable row level security',
    );
    expect(generated).toContain(
      'alter table "public"."approvals" add column if not exists "permdock_token" text;',
    );
    if (db === undefined) {
      throw new Error("PermDock: Postgres was not started");
    }
    await current.create({
      v: 1,
      token: "adopt-token",
      permission: "job.update",
      scope: "job:update",
      resource: { type: "job", id: "j1" },
      subject: { principal: { id: "u1", roles: [], tenant: "acme" } },
      detail: "approval",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      status: "pending",
    });
    await current.resolve("adopt-token", {
      status: "approved",
      by: {
        principal: {
          id: "boss",
          roles: [],
          tenant: "acme",
          memberships: [{ tenant: "acme", roles: ["admin"] }],
        },
        context: {},
      },
    });
    const row = await db.admin.query<{
      state: string;
      organization_id: string;
      requested_by: string;
      approval_count: number;
      expires_at: Date;
      kind: string;
    }>(
      "select state, organization_id, requested_by, approval_count, expires_at, kind from public.approvals where permdock_token = 'adopt-token'",
    );
    expect(row.rows[0]).toMatchObject({
      state: "approved",
      organization_id: "acme",
      requested_by: "u1",
      approval_count: 1,
      kind: "legacy",
    });
    expect(row.rows[0]?.expires_at).toBeInstanceOf(Date);
    const legacy = await db.admin.query<{ state: string }>(
      "select state from public.approvals where requested_by = 'legacy-user'",
    );
    expect(legacy.rows).toEqual([{ state: "pending" }]);
    expect(
      await current.expire(new Date(Date.now() + 3_600_000)),
    ).toBeGreaterThanOrEqual(0);
    const after = await db.admin.query<{ state: string }>(
      "select state from public.approvals where requested_by = 'legacy-user'",
    );
    expect(after.rows).toEqual([{ state: "pending" }]);
  });
});
