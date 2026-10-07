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

import type { SupabasePostgres } from "./support/supabase-postgres.ts";

import { startSupabasePostgres } from "./support/supabase-postgres.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const MEMBER = "00000000-0000-4000-8000-0000000000a1";

const SETUP = `
create table public.job (id text primary key, "orgId" text not null, "ownerId" uuid not null);
create table public.organization_members (organization_id text not null, user_id uuid not null, role text not null);
insert into public.organization_members values ('acme', '${MEMBER}', 'member');
`;

let db: SupabasePostgres | undefined;

function started(): SupabasePostgres {
  if (db === undefined) {
    throw new Error("PermDock: supabase/postgres was not started");
  }
  return db;
}

async function generate(
  fixture: string,
  args: readonly string[],
): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), "permdock-jsonschema-"));
  try {
    const out = join(dir, "out.sql");
    const result = await run([...args, "--out", out], {
      cwd: join(HERE, "../fixtures", fixture),
    });
    if (result.code !== 0) {
      throw new Error(`${args.join(" ")}: ${result.stdout}${result.stderr}`);
    }
    return readFileSync(out, "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** supabase-js shaped, over `postgres`, which owns the store functions. */
function rpcClient(): SupabaseRpcClient {
  return {
    schema(name) {
      return {
        async rpc(fn, args) {
          const names = Object.keys(args);
          const call = `"${name}"."${fn}"(${names.map((arg, index) => `${arg} => $${String(index + 1)}`).join(", ")})`;
          try {
            const result = await started().owner.query<{ data: unknown }>(
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
// The runner registers its cases before the container starts.
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
  const rls = await generate("approvals-jsonschema", [
    "rls",
    "generate",
    "--target",
    "sql",
  ]);
  const hook = await generate("hook-validate", [
    "supabase",
    "hook",
    "generate",
  ]);
  db = await startSupabasePostgres();
  await db.owner.query(SETUP);
  await db.owner.query(rls);
  await db.owner.query(hook);
  current = supabaseApprovalStore(rpcClient());
}, 240_000);

afterAll(async () => {
  await db?.stop();
});

describe("rls.jsonSchema on supabase/postgres", () => {
  testApprovalStore(store, {
    reopen: () => supabaseApprovalStore(rpcClient()),
  });

  it("installs the check and refuses a body that is not a v1 request", async () => {
    const { owner } = started();
    const found = await owner.query<{ convalidated: boolean }>(
      "select convalidated from pg_constraint where conname = 'approval_requests_body_schema'",
    );
    expect(found.rows).toEqual([{ convalidated: true }]);
    const bad = {
      v: 1,
      token: "no-permission",
      status: "pending",
      createdAt: "2026-10-06T09:00:00Z",
      expiresAt: "2099-01-01T00:00:00Z",
    };
    await expect(
      owner.query("select permdock.permdock_approval_open($1::jsonb)", [
        JSON.stringify(bad),
      ]),
    ).rejects.toMatchObject({
      code: "23514",
      constraint: "approval_requests_body_schema",
    });
  });
});

describe("supabase.hook.validate on supabase/postgres", () => {
  async function mint(
    claims: Readonly<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> {
    const { superuser } = started();
    await superuser.query("begin");
    try {
      await superuser.query("set local role supabase_auth_admin");
      const result = await superuser.query<{
        readonly event: { readonly claims: Record<string, unknown> };
      }>("select permdock.custom_access_token_hook($1::jsonb) as event", [
        JSON.stringify({
          user_id: MEMBER,
          claims: { sub: MEMBER, role: "authenticated", ...claims },
        }),
      ]);
      return result.rows[0]?.event.claims ?? {};
    } finally {
      await superuser.query("rollback");
    }
  }

  it("keeps claims that match supabase-claims-v1.json", async () => {
    expect(await mint({})).toMatchObject({
      sub: MEMBER,
      memberships: [{ scope: "tenant", id: "acme", roles: ["member"] }],
    });
  });

  it("drops every PermDock claim, without an error, when one does not match", async () => {
    const claims = await mint({ tenant_id: 42 });
    expect(claims).toEqual({ sub: MEMBER, role: "authenticated" });
  });
});
