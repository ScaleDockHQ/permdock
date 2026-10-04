import { describe as group, expect, it } from "vitest";

import type { ApprovalRequest } from "../../src/approvals/index.ts";
import type { Subject } from "../../src/core/subject.ts";

import {
  approvalsHandler,
  approverRelations,
  memoryApprovalStore,
  requestApproval,
  resolveApproval,
} from "../../src/approvals/index.ts";
import { describe } from "../../src/core/describe.ts";
import { relation } from "../../src/core/grantee.ts";
import { createPermDock } from "../../src/core/permdock.ts";
import { definePermissions, resource } from "../../src/core/permissions.ts";
import {
  allow,
  definePolicy,
  normalizeApproval,
  role,
  user,
} from "../../src/core/policy.ts";
import { permissions, policy, relations, rows } from "../fixtures/expenses.ts";

const BASE = "https://api.example.com/permdock/approvals";

function member(id: string): Subject {
  return {
    principal: {
      id,
      roles: [],
      memberships: [{ tenant: "o1", roles: ["member"] }],
    },
    context: {},
  };
}

async function pendingPayment() {
  const store = memoryApprovalStore();
  const permdock = await createPermDock(policy, { id: "alice" });
  const decision = permdock.decide(permissions.expense.pay, rows.expense[0]);
  if (decision.outcome !== "approval-required") {
    throw new Error(`expected approval-required, got ${decision.outcome}`);
  }
  const request = await requestApproval(store, decision, {
    permission: permissions.expense.pay,
    resource: { type: "expense", id: "e1" },
    subject: permdock.subject,
  });
  return { store, request };
}

group("approval modes and approver kinds", () => {
  it("normalises stages, user approvers and the mode", () => {
    expect(
      normalizeApproval({
        mode: "all",
        stages: [{ by: user("cfo") }, { by: "admin", quorum: 2 }],
        ttl: "1d",
      }),
    ).toEqual({
      mode: "all",
      stages: [
        { by: { kind: "user", id: "cfo" } },
        {
          by: { kind: "role", role: "admin", scope: "global" },
          quorum: 2,
        },
      ],
      ttl: "1d",
    });
    expect(normalizeApproval({ by: [user("cfo"), "admin"] })).toEqual({
      by: [
        { kind: "user", id: "cfo" },
        { kind: "role", role: "admin", scope: "global" },
      ],
    });
  });

  it.each([
    [{ mode: "all" as const }, /at least one stage/u],
    [
      { mode: "sequential" as const, by: "admin", stages: [{ by: "a" }] },
      /put by and quorum on each stage/u,
    ],
    [{ stages: [{ by: "admin" }] }, /needs mode/u],
    [{ mode: "all" as const, stages: [{ by: [] }] }, /names no approver/u],
    [
      { mode: "all" as const, stages: [{ by: "a", quorum: 0 }] },
      /stages\[0\]\.quorum/u,
    ],
    // SAFETY: deliberately invalid input to check the runtime guard.
    [{ mode: "every" as never, stages: [{ by: "a" }] }, /'any', 'all'/u],
  ])("refuses %j", (approval, message) => {
    expect(() => normalizeApproval(approval)).toThrow(message);
  });

  it("refuses an empty user id", () => {
    expect(() => user("")).toThrow(/non-empty/u);
  });

  it("refuses relation approvers the store cannot reach by id", () => {
    const tree = definePermissions({
      team: resource({
        actions: ["read"],
        relations: { lead: { field: "leadId" } },
      }),
      doc: resource({
        collection: ["create"],
        actions: ["read"],
        relations: { owner: { field: "ownerId" } },
      }),
    });
    const build = (grant: ReturnType<typeof allow>) => () =>
      definePolicy(tree, {
        roles: [role("member", [grant])],
        subject: () => null,
      });
    expect(
      build(
        allow(tree.doc.create, {
          approval: { by: relation(tree.doc, "owner") },
        }),
      ),
    ).toThrow(/needs an instance action/u);
    expect(
      build(
        allow(tree.doc.read, {
          approval: { by: relation(tree.team, "lead") },
        }),
      ),
    ).toThrow(/must live on 'doc'/u);
    expect(
      build(
        allow(tree.doc.read, {
          approval: { by: relation(tree.doc, "missing") },
        }),
      ),
    ).toThrow(/not declared on 'doc'/u);
    expect(() =>
      definePolicy(tree, {
        roles: [
          role("admin", [allow(tree.doc.read)], {
            activation: {
              maxDuration: "1h",
              approval: { by: relation(tree.doc, "owner") },
            },
          }),
        ],
        subject: () => null,
      }),
    ).toThrow(/activation has no row/u);
  });

  it("reads relation approvers by the request's resource id", async () => {
    const { request } = await pendingPayment();
    const options = { relations, permissions };
    expect(await approverRelations(request, member("mia"), options)).toEqual([
      JSON.stringify(["expense", "manager", null, null]),
    ]);
    expect(await approverRelations(request, member("rob"), options)).toEqual([
      JSON.stringify(["report", "approver", ["report"], null]),
    ]);
    expect(await approverRelations(request, member("eve"), options)).toEqual(
      [],
    );
    expect(await approverRelations(request, member("mia"), {})).toEqual([]);
    const noId: ApprovalRequest = {
      ...request,
      resource: { type: "expense" },
    };
    expect(await approverRelations(noId, member("mia"), options)).toEqual([]);
  });

  it("runs the manager stage before the report approver through the handler", async () => {
    const { store, request } = await pendingPayment();
    let who = "rob";
    const handler = approvalsHandler(store, {
      subject: () => member(who),
      relations,
      permissions,
    });
    const approve = () =>
      handler(
        new Request(`${BASE}/${encodeURIComponent(request.token)}/approve`, {
          method: "POST",
        }),
      );
    const inbox = async (): Promise<readonly string[]> => {
      const response = await handler(new Request(`${BASE}/pending`));
      // SAFETY: the pending route answers a page of approval requests.
      const body = (await response.json()) as {
        readonly items: readonly ApprovalRequest[];
      };
      return body.items.map((item) => item.token);
    };
    expect(await inbox()).toEqual([]);
    expect((await approve()).status).toBe(403);
    who = "mia";
    expect(await inbox()).toEqual([request.token]);
    expect((await approve()).status).toBe(200);
    who = "rob";
    expect(await inbox()).toEqual([request.token]);
    const done = await approve();
    expect(done.status).toBe(200);
    const body: unknown = await done.json();
    expect(body).toMatchObject({
      status: "approved",
      approvals: [
        { by: "mia", stage: 0 },
        { by: "rob", stage: 1 },
      ],
    });
  });

  it("matches nobody on a relation stage without a relation source", async () => {
    const { store, request } = await pendingPayment();
    const handler = approvalsHandler(store, { subject: () => member("mia") });
    const response = await handler(
      new Request(`${BASE}/${encodeURIComponent(request.token)}/approve`, {
        method: "POST",
      }),
    );
    expect(response.status).toBe(403);
  });

  it("reads relations in resolveApproval and keeps an explicit verdict", async () => {
    const { store, request } = await pendingPayment();
    const first = await resolveApproval(
      store,
      request.token,
      { status: "approved", by: member("mia") },
      { relations, permissions },
    );
    expect(first.approvals).toEqual([
      { by: "mia", at: expect.any(String), stage: 0 },
    ]);
    await expect(
      resolveApproval(store, request.token, {
        status: "approved",
        by: member("rob"),
        relations: [],
      }),
    ).rejects.toThrow(/current stage/u);
  });

  it("lets stages complete in any order under mode all", async () => {
    const store = memoryApprovalStore();
    const base: ApprovalRequest = {
      v: 1,
      token: "all",
      permission: "expense.pay",
      scope: "expense:pay",
      resource: { type: "expense", id: "e1" },
      subject: { principal: { id: "alice", roles: [] } },
      approvers: {
        mode: "all",
        stages: [{ by: user("cfo") }, { by: user("ceo") }],
      },
      detail: "",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
      status: "pending",
    };
    await store.create(base);
    const by = (id: string): Subject => ({
      principal: { id, roles: [] },
      context: {},
    });
    expect(
      await store.resolve("all", { status: "approved", by: by("ceo") }),
    ).toMatchObject({
      status: "pending",
      approvals: [{ by: "ceo", stage: 1 }],
    });
    expect(() =>
      store.resolve("all", { status: "approved", by: by("eve") }),
    ).toThrow(/open stage/u);
    expect(
      (await store.resolve("all", { status: "approved", by: by("cfo") }))
        .status,
    ).toBe("approved");
  });

  it("describes every stage's approvers", async () => {
    const permdock = await createPermDock(policy, { id: "alice" });
    const decision = permdock.decide(permissions.expense.pay, rows.expense[0]);
    expect(describe(decision).detail).toBe(
      "expense.pay requires approval from manager and approver.",
    );
  });
});
