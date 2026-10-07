import type { ApprovalRequest } from "permdock/approvals";
import type { SupabaseRpcClient } from "permdock/supabase";

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "permdock/cli";
import { supabaseApprovalStore } from "permdock/supabase";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { Postgres } from "./support/postgres.ts";

import { startPostgres } from "./support/postgres.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

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
  organization_id text not null,
  title text not null,
  state text not null default 'draft',
  approval_count integer not null default 0
);
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

function request(token: string): ApprovalRequest {
  return {
    v: 1,
    token,
    permission: "job.update",
    scope: "job:update",
    resource: { type: "job", id: "j1" },
    subject: { principal: { id: "u1", roles: [], tenant: "acme" } },
    detail: "approval",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    status: "pending",
  };
}

let generated = "";

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "permdock-approval-attach-"));
  try {
    const out = join(dir, "rls.sql");
    const result = await run(
      ["rls", "generate", "--target", "sql", "--out", out],
      { cwd: join(HERE, "../fixtures/approvals-attach") },
    );
    if (result.code !== 0) {
      throw new Error(`rls generate: ${result.stdout}`);
    }
    generated = readFileSync(out, "utf8");
    db = await startPostgres([SETUP, generated]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 120_000);

afterAll(async () => {
  await db?.stop();
});

describe("supabaseApprovalStore attaching requests to the app's own rows", () => {
  it("writes the store functions in public, where an exposed schema reaches them", () => {
    expect(generated).toContain(
      'create or replace function "public".permdock_approval_open(p_request jsonb)',
    );
    expect(generated).not.toContain('"permdock".permdock_approval_');
  });

  it("attaches a request to the row the app inserted with its own required columns", async () => {
    if (db === undefined) {
      throw new Error("PermDock: Postgres was not started");
    }
    const store = supabaseApprovalStore(rpcClient(), { schema: "public" });
    await db.admin.query(
      "insert into public.approvals (organization_id, title, permdock_token) values ('acme', 'Update job j1', 'attach-token')",
    );
    await store.create(request("attach-token"));
    expect((await store.get("attach-token"))?.status).toBe("pending");
    const opened = await db.admin.query<{ title: string; state: string }>(
      "select title, state from public.approvals where permdock_token = 'attach-token'",
    );
    expect(opened.rows).toEqual([{ title: "Update job j1", state: "pending" }]);
    await store.create({ ...request("attach-token"), detail: "again" });
    expect((await store.get("attach-token"))?.detail).toBe("approval");
    const resolved = await store.resolve("attach-token", {
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
    expect(resolved.status).toBe("approved");
    const after = await db.admin.query<{
      state: string;
      approval_count: number;
    }>(
      "select state, approval_count from public.approvals where permdock_token = 'attach-token'",
    );
    expect(after.rows).toEqual([{ state: "approved", approval_count: 1 }]);
  });

  it("refuses to open a request no application row holds", async () => {
    const store = supabaseApprovalStore(rpcClient(), { schema: "public" });
    await expect(store.create(request("orphan-token"))).rejects.toThrow(
      /no row of public.approvals holds approval token orphan-token/u,
    );
    expect(await store.get("orphan-token")).toBeNull();
  });
});
