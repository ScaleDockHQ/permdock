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
`;

let db: Postgres | undefined;
const opened: string[] = [];

/** A supabase-js shaped client over the superuser connection, as a backend role granted the functions calls them. */
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

const open = (): ApprovalStore =>
  supabaseApprovalStore(rpcClient(), {
    onOpen: (request) => {
      opened.push(request.token);
    },
  });

let current: ApprovalStore = open();
// The runner registers its cases before Postgres starts.
const store: ApprovalStore = {
  create: (request) => current.create(request),
  get: (token) => current.get(token),
  resolve: (token, verdict) => current.resolve(token, verdict),
  consume: (token, now) => current.consume(token, now),
  list: (query) => current.list(query),
  expire: (now) => current.expire(now),
  cancel: (filter, meta) => current.cancel?.(filter, meta) ?? 0,
};

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), "permdock-approval-store-"));
  try {
    const out = join(dir, "rls.sql");
    const result = await run(
      ["rls", "generate", "--target", "sql", "--out", out],
      { cwd: join(HERE, "../fixtures/approvals-sql") },
    );
    if (result.code !== 0) {
      throw new Error(`rls generate: ${result.stdout}`);
    }
    db = await startPostgres([SETUP, readFileSync(out, "utf8")]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  current = open();
}, 120_000);

afterAll(async () => {
  await db?.stop();
});

describe("supabaseApprovalStore over the generated store", () => {
  testApprovalStore(store, { reopen: () => open() });

  it("runs onOpen once for a request a repeated ask finds still open", async () => {
    const request = {
      v: 1 as const,
      token: "repeat-token",
      permission: "job.update",
      scope: "job:update",
      resource: { type: "job", id: "j1" },
      subject: { principal: { id: "u1", roles: [] } },
      detail: "approval",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      status: "pending" as const,
    };
    await current.create(request);
    await current.create({
      ...request,
      createdAt: new Date(Date.now() + 1000).toISOString(),
    });
    expect(opened.filter((token) => token === "repeat-token")).toEqual([
      "repeat-token",
    ]);
  });

  it("tells onOpen about each opened request and keeps client roles out", async () => {
    expect(opened.length).toBeGreaterThan(0);
    if (db === undefined) {
      throw new Error("PermDock: Postgres was not started");
    }
    const target = db;
    await expect(
      target.as({ role: "authenticated" }, async () =>
        target.tester.query("select * from permdock.approval_requests"),
      ),
    ).rejects.toThrow(/permission denied/u);
    await expect(
      target.as({ role: "authenticated" }, async () =>
        target.tester.query("select permdock.permdock_approval_get('x')"),
      ),
    ).rejects.toThrow(/permission denied/u);
  });
});
