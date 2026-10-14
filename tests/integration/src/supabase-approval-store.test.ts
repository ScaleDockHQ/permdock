import type { ApprovalStore } from "permdock/approvals";
import type { SupabaseRpcClient } from "permdock/supabase";

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { authorizationProvider } from "permdock/better-supabase";
import { run } from "permdock/cli";
import { supabaseApprovalStore } from "permdock/supabase";
import {
  supabaseHookManifestFixture,
  testApprovalStore,
} from "permdock/testing";
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
      id: "repeat",
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

describe("permdock_is_approver", () => {
  const ADMIN = "00000000-0000-4000-8000-000000000001";
  const SUPPORT = "00000000-0000-4000-8000-000000000002";
  const claims: Record<string, unknown> = {
    [ADMIN]: {
      sub: ADMIN,
      memberships: [{ scope: "tenant", id: "o1", roles: ["admin"] }],
    },
    [SUPPORT]: { sub: SUPPORT, user_role: "support" },
  };

  async function isApprover(
    user: string | undefined,
    approvers: unknown,
    tenant: string | null = null,
  ): Promise<boolean> {
    if (db === undefined) {
      throw new Error("PermDock: Postgres was not started");
    }
    const target = db;
    return target.as(
      {
        role: "authenticated",
        settings: {
          "request.jwt.claims":
            user === undefined ? "{}" : JSON.stringify(claims[user]),
        },
      },
      async () => {
        const result = await target.tester.query<{ readonly ok: boolean }>(
          "select permdock.permdock_is_approver($1::jsonb, $2) as ok",
          [JSON.stringify(approvers), tenant],
        );
        return result.rows[0]?.ok === true;
      },
    );
  }

  it("matches a named user and a permission holder in the tenant", async () => {
    expect(await isApprover(ADMIN, { kind: "user", id: ADMIN })).toBe(true);
    expect(await isApprover(SUPPORT, { kind: "user", id: ADMIN })).toBe(false);
    const holder = { kind: "permission", permission: "job.update" };
    expect(await isApprover(ADMIN, holder, "o1")).toBe(true);
    expect(await isApprover(ADMIN, holder, "o2")).toBe(false);
    expect(
      await isApprover(SUPPORT, { kind: "permission", permission: "job.read" }),
    ).toBe(true);
  });

  it("needs every item of a list and one of any-of, and denies what SQL cannot check", async () => {
    const user = { kind: "user", id: ADMIN };
    const holder = { kind: "permission", permission: "job.update" };
    expect(await isApprover(ADMIN, [user, holder], "o1")).toBe(true);
    expect(await isApprover(SUPPORT, [user, holder], "o1")).toBe(false);
    expect(
      await isApprover(SUPPORT, {
        kind: "any-of",
        of: [user, { kind: "user", id: SUPPORT }],
      }),
    ).toBe(true);
    expect(await isApprover(ADMIN, { kind: "role", role: "admin" })).toBe(
      false,
    );
    expect(await isApprover(ADMIN, [])).toBe(false);
    expect(await isApprover(undefined, user)).toBe(false);
  });

  it("answers better-supabase's isApprover template from authorizationProvider", async () => {
    const provider = authorizationProvider({
      manifest: {
        ...supabaseHookManifestFixture,
        rls: {
          ...supabaseHookManifestFixture.rls,
          helpers: [
            ...supabaseHookManifestFixture.rls.helpers,
            {
              name: "permdock_is_approver",
              args: "p_approvers jsonb, p_tenant text",
              returns: "boolean",
              execute: ["authenticated"],
            },
          ],
        },
      },
      approvers: {
        "job.update": { kind: "permission", permission: "job.update" },
        "support-session": { kind: "user", id: SUPPORT },
      },
    });
    const template = provider.functions.isApprover;
    if (template === undefined) {
      throw new Error(`no isApprover: ${String(provider.problems)}`);
    }
    const check = async (user: string, kind: string, tenant: string) => {
      if (db === undefined) {
        throw new Error("PermDock: Postgres was not started");
      }
      const target = db;
      const sql = template
        .replaceAll("{kind}", "$1::text")
        .replaceAll("{tenant}", "$2::text");
      return target.as(
        {
          role: "authenticated",
          settings: { "request.jwt.claims": JSON.stringify(claims[user]) },
        },
        async () => {
          const result = await target.tester.query<{ readonly ok: boolean }>(
            `select ${sql} as ok`,
            [kind, tenant],
          );
          return result.rows[0]?.ok === true;
        },
      );
    };
    expect(await check(ADMIN, "job.update", "o1")).toBe(true);
    expect(await check(ADMIN, "job.update", "o2")).toBe(false);
    expect(await check(SUPPORT, "job.update", "o1")).toBe(false);
    expect(await check(SUPPORT, "support-session", "o1")).toBe(true);
    expect(await check(ADMIN, "support-session", "o1")).toBe(false);
    expect(await check(ADMIN, "invoice.send", "o1")).toBe(false);
  });
});
