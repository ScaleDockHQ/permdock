import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { ApprovalStore } from "../../src/approvals/index.ts";
import type { ChatCommandResult } from "../../src/chat/index.ts";
import type { Principal } from "../../src/core/subject.ts";

import { memoryApprovalStore } from "../../src/approvals/index.ts";
import { createPermDock } from "../../src/chat/index.ts";
import { holder } from "../../src/core/approvers.ts";
import { allow } from "../../src/core/grant-builders.ts";
import { anyone } from "../../src/core/grantee.ts";
import { memoryMembershipSource } from "../../src/core/memory-sources.ts";
import { defineOperations } from "../../src/core/operations.ts";
import { resource } from "../../src/core/permission-leaf.ts";
import { definePermissions } from "../../src/core/permissions.ts";
import { definePolicy } from "../../src/core/policy.ts";
import { memoryPrincipalSource } from "../../src/core/principal-source.ts";
import { role } from "../../src/core/role-builder.ts";

const Invoice = z.object({ id: z.string(), orgId: z.string() });

const p = definePermissions({
  invoice: resource(Invoice, {
    id: "id",
    actions: ["read", "pay"],
    collection: ["export", "approve", "ping"],
    relations: { org: { field: "orgId", memberOf: "tenant" } },
  }),
});

const policy = definePolicy(p, {
  scopes: { tenant: { key: "orgId" } },
  roles: [
    role("member", [allow(p.invoice.read)], { on: "tenant" }),
    role(
      "billing",
      [
        allow(p.invoice.read),
        allow(p.invoice.pay, { approval: { by: holder(p.invoice.approve) } }),
        allow(p.invoice.export, { approval: {} }),
      ],
      { on: "tenant" },
    ),
    role("approver", [allow(p.invoice.approve)], { on: "tenant" }),
  ],
  grants: [allow(p.invoice.ping, { to: anyone() })],
  subject: (user: Principal | null) => user,
});

const invoices: Readonly<
  Record<string, { readonly id: string; readonly orgId: string }>
> = { i1: { id: "i1", orgId: "o1" } };

const operations = defineOperations(p, {
  "invoice.pay": {
    permission: p.invoice.pay,
    data: (input: { readonly id: string }) => invoices[input.id] ?? null,
    meta: { risk: "high", effects: ["spend"], title: "Pay an invoice" },
  },
  "invoice.export": {
    permission: p.invoice.export,
    meta: { risk: "medium", title: "Export invoices" },
  },
  "invoice.ping": { permission: p.invoice.ping },
});

function link(user: string, principal: string) {
  return {
    identity: {
      kind: "chat" as const,
      provider: "slack",
      value: user,
      workspace: "T1",
    },
    principal,
  };
}

const principals = memoryPrincipalSource({
  principals: [
    { id: "u_1", kind: "user", tenant: "o1" },
    { id: "u_2", kind: "user", tenant: "o1" },
    { id: "u_3", kind: "user", tenant: "o1" },
    { id: "u_4", kind: "user", tenant: "o1" },
  ],
  identities: [
    link("U1", "u_1"),
    link("U2", "u_2"),
    link("U3", "u_3"),
    link("U4", "u_4"),
  ],
});

const memberships = memoryMembershipSource({
  u_1: [{ scope: "tenant", id: "o1", roles: ["billing"] }],
  u_2: [{ scope: "tenant", id: "o1", roles: ["member"] }],
  u_3: [{ scope: "tenant", id: "o1", roles: ["approver"] }],
  u_4: [{ scope: "tenant", id: "o1", roles: ["billing"] }],
});

const billing = { provider: "slack", userId: "U1", workspace: "T1" };
const member = { provider: "slack", userId: "U2", workspace: "T1" };
const approver = { provider: "slack", userId: "U3", workspace: "T1" };
const secondBilling = { provider: "slack", userId: "U4", workspace: "T1" };

function pagedStore(): {
  readonly store: ApprovalStore;
  readonly pages: () => number;
} {
  const inner = memoryApprovalStore();
  let pages = 0;
  const store: ApprovalStore = {
    create: (request) => inner.create(request),
    get: (token) => inner.get(token),
    resolve: (token, verdict) => inner.resolve(token, verdict),
    list: (query) => {
      pages += 1;
      return inner.list({ ...query, limit: 1 });
    },
    expire: (now) => inner.expire(now),
    consume: (token, now) => inner.consume(token, now),
  };
  return { store, pages: () => pages };
}

function chat(approvals?: ApprovalStore) {
  return createPermDock(policy, {
    principals,
    memberships,
    ...(approvals === undefined ? {} : { store: approvals }),
  });
}

function promptId(result: ChatCommandResult<unknown>): string {
  if (result.outcome !== "approval-required" || result.prompt === null) {
    throw new Error("expected an approval prompt");
  }
  return result.prompt.id;
}

describe("ChatPermDock.protect edge cases", () => {
  it("opens a request with only the resource type for an operation without a row", async () => {
    const store = memoryApprovalStore();
    const handler = vi.fn<() => string>(() => "exported");
    const run = chat(store).protect(operations["invoice.export"], handler);
    const result = await run(billing, undefined);
    expect(result.outcome).toBe("approval-required");
    expect(
      result.outcome === "approval-required" && result.prompt?.resource,
    ).toStrictEqual({ type: "invoice" });
    const [request] = (await store.list({})).items;
    expect(request?.resource).toStrictEqual({ type: "invoice" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("denies a granted anonymous caller with validation and never runs the handler", async () => {
    const handler = vi.fn<() => string>(() => "pong");
    const ping = chat().protect(operations["invoice.ping"], handler);
    for (const author of [null, undefined, { provider: "slack", userId: "" }]) {
      const result = await ping(author, undefined);
      expect(result.outcome).toBe("denied");
      expect(
        result.outcome === "denied" && result.decision.denials[0]?.reason,
      ).toBe("validation");
    }
    expect(await ping(member, undefined)).toStrictEqual({
      outcome: "granted",
      value: "pong",
    });
    expect(handler).toHaveBeenCalledOnce();
  });
});

describe("ChatPermDock.resolveAction edge cases", () => {
  it("reports approval-not-found for a linked approver when there is no store", async () => {
    expect(
      await chat().resolveAction(approver, {
        approval: "apr_1",
        status: "approved",
      }),
    ).toStrictEqual({ ok: false, cause: "approval-not-found" });
  });

  it("lets only a holder of the approver permission approve", async () => {
    const permdock = chat(memoryApprovalStore());
    const handler = vi.fn<() => string>(() => "paid");
    const pay = permdock.protect(operations["invoice.pay"], handler);
    const id = promptId(await pay(billing, { id: "i1" }));
    expect(
      await permdock.resolveAction(member, {
        approval: id,
        status: "approved",
      }),
    ).toStrictEqual({ ok: false, cause: "approver-not-eligible" });
    expect(
      await permdock.resolveAction(approver, {
        approval: id,
        status: "approved",
      }),
    ).toStrictEqual({ ok: true, id, status: "approved" });
    expect(await pay(billing, { id: "i1" })).toStrictEqual({
      outcome: "granted",
      value: "paid",
    });
  });

  it("pages through a store without getById to find the request", async () => {
    const { store, pages } = pagedStore();
    const permdock = chat(store);
    const pay = permdock.protect(operations["invoice.pay"], () => "paid");
    const ids = [
      promptId(await pay(billing, { id: "i1" })),
      promptId(await pay(secondBilling, { id: "i1" })),
    ];
    const firstPage = new Set(
      (await store.list({})).items.map((item) => item.id),
    );
    const second = ids.find((id) => !firstPage.has(id)) ?? "";
    const before = pages();
    expect(
      await permdock.resolveAction(approver, {
        approval: second,
        status: "rejected",
        note: "not this month",
      }),
    ).toStrictEqual({ ok: true, id: second, status: "rejected" });
    expect(pages() - before).toBe(2);
    expect(
      await permdock.resolveAction(approver, {
        approval: "apr_missing",
        status: "approved",
      }),
    ).toStrictEqual({ ok: false, cause: "approval-not-found" });
  });
});
