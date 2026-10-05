import { describe, expect, it } from "vitest";

import type { ApprovalRequest } from "../../src/approvals/index.ts";
import type { Subject } from "../../src/core/subject.ts";

import {
  approvalsHandler,
  approverPermissions,
  assertApprover,
  memoryApprovalStore,
  requestApproval,
} from "../../src/approvals/index.ts";
import { tightenApproval } from "../../src/core/approval-policies.ts";
import { describe as describeDecision } from "../../src/core/describe.ts";
import {
  allOf,
  allow,
  anyOf,
  createPermDock,
  definePermissions,
  definePolicy,
  holder,
  memoryRoleSource,
  normalizeApproval,
  resource,
  role,
  user,
  validateApprovalPolicy,
} from "../../src/index.ts";

const permissions = definePermissions({
  payment: resource({
    actions: ["send", "approve"],
    relations: { org: { field: "orgId", memberOf: "tenant" } },
  }),
});

const policy = definePolicy(permissions, {
  scopes: { tenant: { key: "orgId" } },
  roles: [
    role(
      "clerk",
      [
        allow(permissions.payment.send, {
          approval: {
            by: anyOf(user("cfo"), holder(permissions.payment.approve)),
          },
        }),
      ],
      { on: "tenant" },
    ),
    role("controller", [allow(permissions.payment.approve)], {
      on: "tenant",
      assignable: true,
    }),
    role("auditor", [], { on: "tenant" }),
  ],
  subject: (person: { readonly id: string } | null) =>
    person === null ? null : { id: person.id },
});

function inTenant(id: string, roles: readonly string[]): Subject {
  return {
    principal: {
      id,
      tenant: "o1",
      roles: [],
      memberships: [{ scope: "tenant", id: "o1", roles: [...roles] }],
    },
    context: {},
  };
}

async function pending(): Promise<{
  readonly store: ReturnType<typeof memoryApprovalStore>;
  readonly request: ApprovalRequest;
}> {
  const store = memoryApprovalStore();
  const permdock = await createPermDock(policy, inTenant("cara", ["clerk"]));
  const decision = permdock.decide(permissions.payment.send, {
    id: "p1",
    orgId: "o1",
  });
  if (decision.outcome !== "approval-required") {
    throw new Error(`expected approval-required, got ${decision.outcome}`);
  }
  const request = await requestApproval(store, decision, {
    permission: permissions.payment.send,
    resource: { type: "payment", id: "p1" },
    subject: permdock.subject,
  });
  return { store, request };
}

describe("approver kinds", () => {
  it("anyOf matches an approver who satisfies one item", async () => {
    const { request } = await pending();
    expect(() =>
      assertApprover(request, inTenant("cfo", []), false),
    ).not.toThrow();
    expect(() =>
      assertApprover(request, inTenant("ann", ["auditor"]), false),
    ).toThrow(/eligible/u);
  });

  it("holder matches through the permission facts, never without them", async () => {
    const { request } = await pending();
    const dana = inTenant("dana", ["controller"]);
    expect(() => assertApprover(request, dana, false)).toThrow(/eligible/u);
    const held = approverPermissions(
      request,
      await createPermDock(policy, dana),
    );
    expect(held).toEqual(["payment.approve"]);
    expect(() =>
      assertApprover(request, dana, false, new Date(), [], held),
    ).not.toThrow();
  });

  it("a custom role that grants the permission makes its holder an approver", async () => {
    const { request } = await pending();
    const erin = inTenant("erin", ["treasury"]);
    const instance = await createPermDock(policy, erin, {
      customRoles: memoryRoleSource([
        {
          name: "treasury",
          tenant: "o1",
          grants: [{ permission: "payment.approve" }],
          includes: ["controller"],
        },
      ]),
    });
    expect(approverPermissions(request, instance)).toEqual(["payment.approve"]);
  });

  it("an instance for another tenant or principal holds nothing", async () => {
    const { request } = await pending();
    const elsewhere: Subject = {
      principal: {
        id: "dana",
        tenant: "o2",
        roles: [],
        memberships: [{ scope: "tenant", id: "o2", roles: ["controller"] }],
      },
      context: {},
    };
    expect(
      approverPermissions(request, await createPermDock(policy, elsewhere)),
    ).toEqual([]);
  });

  it("approvalsHandler reads holders through permdockFor", async () => {
    const { store, request } = await pending();
    const handler = approvalsHandler(store, {
      subject: () => inTenant("dana", ["controller"]),
      permdockFor: (approver) => createPermDock(policy, approver),
    });
    const response = await handler(
      new Request(
        `https://api.example.com/approvals/${encodeURIComponent(request.token)}/approve`,
        { method: "POST" },
      ),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "approved" });
  });

  it("allOf is a list, and a list inside anyOf needs every entry", () => {
    expect(normalizeApproval({ by: allOf(user("a"), "controller") })).toEqual({
      by: [
        { kind: "user", id: "a" },
        { kind: "role", role: "controller", scope: "global" },
      ],
    });
    expect(
      normalizeApproval({ by: anyOf([user("a"), "controller"], user("b")) }),
    ).toEqual({
      by: {
        kind: "any-of",
        of: [
          [
            { kind: "user", id: "a" },
            { kind: "role", role: "controller", scope: "global" },
          ],
          { kind: "user", id: "b" },
        ],
      },
    });
    expect(() => anyOf()).toThrow(/at least one approver/u);
  });

  it("describe names holders and any-of groups", async () => {
    const permdock = await createPermDock(policy, inTenant("cara", ["clerk"]));
    expect(
      describeDecision(
        permdock.decide(permissions.payment.send, { id: "p1", orgId: "o1" }),
      ).detail,
    ).toBe(
      "payment.send requires approval from one of (user cfo, a holder of payment.approve).",
    );
  });
});

describe("escalation in data and per stage", () => {
  it("an entry's escalation widens only its own stage", () => {
    const code = normalizeApproval({
      by: "controller",
      escalation: { after: "1d", to: user("ceo") },
    });
    expect(
      validateApprovalPolicy(policy, {
        permission: "payment.send",
        approval: {
          by: user("cfo"),
          escalation: { after: "4h", to: "auditor" },
        },
      }),
    ).toEqual({ ok: true });
    const tightened = tightenApproval(
      code,
      [
        {
          permission: "payment.send",
          approval:
            normalizeApproval({
              by: user("cfo"),
              escalation: { after: "4h", to: "auditor" },
            }) ?? "human",
        },
      ],
      {
        permission: "payment.send",
        tenant: undefined,
        subject: inTenant("cara", ["clerk"]),
        current: undefined,
        next: undefined,
        now: 0,
        scopes: [],
      },
    );
    expect(tightened).toMatchObject({
      mode: "all",
      escalation: { after: "1d", to: { kind: "user", id: "ceo" } },
      stages: [
        { by: { kind: "role", role: "controller" } },
        {
          by: { kind: "user", id: "cfo" },
          escalation: { after: "4h", to: { kind: "role", role: "auditor" } },
        },
      ],
    });
    expect(
      tightened !== undefined &&
        tightened !== "human" &&
        tightened.stages?.[0]?.escalation,
    ).toBeUndefined();
  });

  it("a stage escalation opens only after its wait, for that stage", async () => {
    const staged = definePolicy(permissions, {
      scopes: { tenant: { key: "orgId" } },
      roles: [
        role(
          "clerk",
          [
            allow(permissions.payment.send, {
              approval: {
                mode: "all",
                stages: [
                  { by: "controller" },
                  {
                    by: user("cfo"),
                    escalation: { after: "4h", to: "auditor" },
                  },
                ],
              },
            }),
          ],
          { on: "tenant" },
        ),
        role("controller", [], { on: "tenant" }),
        role("auditor", [], { on: "tenant" }),
      ],
      subject: (person: { readonly id: string } | null) =>
        person === null ? null : { id: person.id },
    });
    const store = memoryApprovalStore();
    const permdock = await createPermDock(staged, inTenant("cara", ["clerk"]));
    const decision = permdock.decide(permissions.payment.send, {
      id: "p1",
      orgId: "o1",
    });
    if (decision.outcome !== "approval-required") {
      throw new Error("expected approval-required");
    }
    const created = new Date("2026-10-05T08:00:00Z");
    const request = await requestApproval(store, decision, {
      permission: permissions.payment.send,
      resource: { type: "payment", id: "p1" },
      subject: permdock.subject,
      now: created,
      ttl: 24 * 60 * 60 * 1000,
    });
    const auditor = inTenant("ann", ["auditor"]);
    const early = new Date("2026-10-05T09:00:00Z");
    const late = new Date("2026-10-05T13:00:00Z");
    expect(() => assertApprover(request, auditor, false, early)).toThrow(
      /eligible/u,
    );
    expect(assertApprover(request, auditor, false, late)).toBe(1);
  });
});
