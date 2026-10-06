import { describe, expect, it } from "vitest";

import type { ApprovalRequest } from "../../src/approvals/types.ts";
import type { SupabaseRpcClient } from "../../src/supabase/index.ts";

import { approvalStoreSql } from "../../src/cli/rls-approvals.ts";
import { supabaseApprovalStore } from "../../src/supabase/index.ts";

const request: ApprovalRequest = {
  v: 1,
  token: "t1",
  permission: "invoice.void",
  scope: "tenant",
  resource: { type: "invoice", id: "i1" },
  subject: { principal: { id: "u1", roles: [], tenant: "o1" } },
  detail: "human",
  createdAt: "2026-10-05T10:00:00.000Z",
  expiresAt: "2099-10-05T10:00:00.000Z",
  status: "pending",
};

type Call = { readonly fn: string; readonly args: Record<string, unknown> };

function client(
  answer: (call: Call) => { data: unknown; error: { message: string } | null },
  calls: Call[] = [],
): SupabaseRpcClient {
  return {
    schema(name) {
      expect(name).toBe("auth_z");
      return {
        rpc(fn, args) {
          const call = { fn, args: { ...args } };
          calls.push(call);
          return Promise.resolve(answer(call));
        },
      };
    },
  };
}

describe("supabaseApprovalStore", () => {
  it("calls one function per method with the stored bodies", async () => {
    const calls: Call[] = [];
    const opened: string[] = [];
    const store = supabaseApprovalStore(
      client((call) => {
        switch (call.fn) {
          case "permdock_approval_get":
            return {
              data: call.args["p_token"] === "t1" ? request : null,
              error: null,
            };
          case "permdock_approval_list":
            return {
              data: [request, { ...request, token: "t2" }, "junk"],
              error: null,
            };
          case "permdock_approval_expire":
          case "permdock_approval_cancel":
            return { data: 2, error: null };
          default:
            return { data: null, error: null };
        }
      }, calls),
      {
        schema: "auth_z",
        ttl: 1000,
        onOpen: (stored) => {
          opened.push(stored.token);
        },
      },
    );
    expect(store.ttl).toBe(1000);
    await store.create(request);
    expect(opened).toEqual(["t1"]);
    expect(await store.get("t1")).toBe(request);
    expect(await store.get("nope")).toBeNull();
    const page = await store.list({
      status: "pending",
      tenant: "o1",
      limit: 1,
    });
    expect(page.items).toEqual([request]);
    expect(page.next).toBe(JSON.stringify([request.createdAt, "t1"]));
    expect(await store.list({ cursor: "not json" })).toEqual({ items: [] });
    expect(
      await store.consume("t1", new Date("2026-10-05T11:00:00Z")),
    ).toBeNull();
    expect(await store.expire(new Date("2026-10-05T11:00:00Z"))).toBe(2);
    expect(await store.cancel?.({ tenant: "o1" }, { by: "cleanup" })).toBe(2);
    expect(
      calls.find((call) => call.fn === "permdock_approval_list")?.args,
    ).toEqual({
      p_filter: { status: "pending", tenant: "o1" },
      p_after_created: null,
      p_after_token: null,
      p_limit: 2,
    });
    expect(
      calls.find((call) => call.fn === "permdock_approval_cancel")?.args,
    ).toMatchObject({
      p_filter: { tenant: "o1" },
      p_by: "cleanup",
      p_note: null,
    });
  });

  it("runs onOpen once per stored request, not for a repeated ask that finds it open", async () => {
    let stored: ApprovalRequest | null = null;
    const opened: string[] = [];
    const store = supabaseApprovalStore(
      client((call) => {
        if (call.fn === "permdock_approval_open") {
          stored ??= request;
          return { data: null, error: null };
        }
        return { data: stored, error: null };
      }),
      {
        schema: "auth_z",
        onOpen: (opening) => {
          opened.push(opening.createdAt);
        },
      },
    );
    await store.create(request);
    await store.create({ ...request, createdAt: "2026-10-05T10:05:00.000Z" });
    expect(opened).toEqual([request.createdAt]);
    const lost = supabaseApprovalStore(
      client(() => ({ data: null, error: null })),
      {
        schema: "auth_z",
        onOpen: () => {
          opened.push("lost");
        },
      },
    );
    await lost.create(request);
    expect(opened).toEqual([request.createdAt]);
  });

  it("refuses a verdict on a missing or no longer pending request", async () => {
    const store = supabaseApprovalStore(
      client((call) =>
        call.fn === "permdock_approval_get" && call.args["p_token"] === "t1"
          ? { data: request, error: null }
          : { data: null, error: null },
      ),
      { schema: "auth_z" },
    );
    const by = {
      principal: {
        id: "u2",
        tenant: "o1",
        memberships: [{ tenant: "o1", roles: [] }],
      },
      context: {},
    };
    await expect(
      store.resolve("nope", { status: "approved", by }),
    ).rejects.toMatchObject({
      code: "approval-not-found",
    });
    await expect(
      store.resolve("t1", { status: "approved", by }),
    ).rejects.toMatchObject({
      code: "approval-not-pending",
    });
  });

  it("rejects when a function fails and reads a non-number count as zero", async () => {
    const failing = supabaseApprovalStore(
      client(() => ({ data: null, error: { message: "denied" } })),
      { schema: "auth_z" },
    );
    await expect(failing.get("t1")).rejects.toThrow(
      "PermDock: auth_z.permdock_approval_get failed: denied",
    );
    const odd = supabaseApprovalStore(
      client(() => ({ data: "x", error: null })),
      { schema: "auth_z" },
    );
    expect(await odd.expire()).toBe(0);
    expect(await odd.cancel?.({}, { by: "x", note: "n" })).toBe(0);
    expect((await odd.list({})).items).toEqual([]);
  });

  it("generates the store closed to client roles", () => {
    const sql = approvalStoreSql({
      dialect: "supabase",
      tenantClaim: "tenant_id",
      scopes: [],
      gucPrefix: "app",
    });
    expect(sql).toContain(
      'create table if not exists "permdock".approval_requests',
    );
    expect(sql).toContain(
      'revoke execute on function "permdock".permdock_approval_consume(text, text) from public, anon, authenticated;',
    );
    expect(sql).not.toMatch(/grant /u);
  });
});
