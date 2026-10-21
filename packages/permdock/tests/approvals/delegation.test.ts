import { describe, expect, it } from "vitest";

import type { ApprovalRequest } from "../../src/approvals/index.ts";
import type { Subject } from "../../src/core/subject.ts";

import {
  applyApprovalVerdict,
  approvalsHandler,
  matchDelegation,
  memoryApprovalDelegationSource,
  memoryApprovalStore,
  parseApprovalDelegation,
  requestApproval,
} from "../../src/approvals/index.ts";
import { approverRelationKey } from "../../src/approvals/types.ts";
import {
  allow,
  getPermDockSync,
  definePermissions,
  definePolicy,
  holder,
  relation,
  resource,
  role,
  user,
} from "../../src/index.ts";
import { testApprovalDelegationSource } from "../../src/testing/index.ts";

const permissions = definePermissions({
  payment: resource({
    actions: ["send", "approve"],
    relations: {
      org: { field: "orgId", memberOf: "tenant" },
      manager: { principal: "userId" },
    },
  }),
});

const policy = definePolicy(permissions, {
  scopes: { tenant: { key: "orgId" } },
  roles: [
    role(
      "clerk",
      [allow(permissions.payment.send, { approval: { by: user("cfo") } })],
      { on: "tenant" },
    ),
    role(
      "payer",
      [
        allow(permissions.payment.send, {
          approval: { by: holder(permissions.payment.approve) },
        }),
      ],
      { on: "tenant" },
    ),
    role(
      "reporter",
      [
        allow(permissions.payment.send, {
          approval: { by: relation(permissions.payment, "manager") },
        }),
      ],
      { on: "tenant" },
    ),
    role("controller", [allow(permissions.payment.approve)], { on: "tenant" }),
  ],
  subject: (person: { readonly id: string } | null) =>
    person === null ? null : { id: person.id },
});

const HOUR = 60 * 60 * 1000;

function inTenant(id: string, roles: readonly string[] = []): Subject {
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

function window(around: Date): {
  readonly from: string;
  readonly until: string;
} {
  return {
    from: new Date(around.getTime() - HOUR).toISOString(),
    until: new Date(around.getTime() + HOUR).toISOString(),
  };
}

async function pending(
  leaf: typeof permissions.payment.send = permissions.payment.send,
): Promise<{
  readonly store: ReturnType<typeof memoryApprovalStore>;
  readonly request: ApprovalRequest;
}> {
  const store = memoryApprovalStore();
  const permdock = getPermDockSync(policy, inTenant("cara", ["clerk"]));
  const decision = permdock.decide(leaf, { id: "p1", orgId: "o1" });
  if (decision.outcome !== "approval-required") {
    throw new Error(`expected approval-required, got ${decision.outcome}`);
  }
  const request = await requestApproval(store, decision, {
    permission: leaf,
    resource: { type: "payment", id: "p1" },
    subject: permdock.subject,
  });
  return { store, request };
}

// approvalsHandler reads the real clock, so the delegation window is built around it.
const now = new Date();

describe("approver delegation", () => {
  const delegations = memoryApprovalDelegationSource([
    {
      id: "d1",
      delegator: "cfo",
      delegate: "dana",
      tenant: "o1",
      ...window(now),
    },
  ]);

  testApprovalDelegationSource(delegations, {
    delegate: "dana",
    delegator: "cfo",
    tenant: "o1",
    at: now.toISOString(),
  });

  it("treats from as inclusive and until as exclusive", () => {
    const source = memoryApprovalDelegationSource([
      {
        id: "edge",
        delegator: "cfo",
        delegate: "dana",
        from: "2026-10-13T12:00:00.000Z",
        until: "2026-10-20T12:00:00.000Z",
      },
    ]);
    expect(
      source.delegationsFor({
        delegate: "dana",
        at: "2026-10-13T12:00:00.000Z",
      }),
    ).toHaveLength(1);
    expect(
      source.delegationsFor({
        delegate: "dana",
        at: "2026-10-20T12:00:00.000Z",
      }),
    ).toStrictEqual([]);
  });

  it("records the delegate acting for the delegator", async () => {
    const { store, request } = await pending();
    const handler = approvalsHandler(store, {
      subject: () => inTenant("dana"),
      approvalDelegations: delegations,
      subjectFor: () => inTenant("cfo"),
    });
    const response = await handler(
      new Request(
        `https://api.example.com/approvals/${encodeURIComponent(request.id)}/approve`,
        { method: "POST" },
      ),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: "approved",
      resolvedBy: "dana",
      approvals: [{ by: "dana", onBehalfOf: "cfo", delegation: "d1" }],
    });
  });

  it("refuses a delegate who is the requester", async () => {
    const { request } = await pending();
    const source = memoryApprovalDelegationSource([
      {
        id: "self",
        delegator: "cfo",
        delegate: "cara",
        tenant: "o1",
        ...window(new Date()),
      },
    ]);
    expect(() =>
      applyApprovalVerdict(request, {
        status: "approved",
        by: inTenant("cara", ["clerk"]),
        onBehalfOf: { subject: inTenant("cfo"), delegation: "self" },
      }),
    ).toThrow(/principal/u);
    expect(
      source.delegationsFor({
        delegate: "cara",
        tenant: "o1",
        at: new Date().toISOString(),
      }),
    ).toHaveLength(1);
  });

  it("refuses a delegation whose delegator is the requester", () => {
    const request = {
      v: 1 as const,
      id: "r1",
      token: "t",
      permission: "payment.send",
      scope: "payment:send",
      resource: { type: "payment", id: "p1" },
      subject: { principal: { id: "cfo", roles: ["clerk"], tenant: "o1" } },
      detail: "send",
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + HOUR).toISOString(),
      status: "pending" as const,
      approvers: { by: user("cfo") },
    };
    expect(() =>
      applyApprovalVerdict(request, {
        status: "approved",
        by: inTenant("dana"),
        onBehalfOf: { subject: inTenant("cfo"), delegation: "d1" },
      }),
    ).toThrow(/principal/u);
  });

  it("does not follow a second hop", async () => {
    const { store, request } = await pending();
    const chain = memoryApprovalDelegationSource([
      {
        id: "hop",
        delegator: "erin",
        delegate: "dana",
        tenant: "o1",
        ...window(new Date()),
      },
    ]);
    const handler = approvalsHandler(store, {
      subject: () => inTenant("dana"),
      approvalDelegations: chain,
      subjectFor: (id) => (id === "erin" ? inTenant("erin") : null),
    });
    const response = await handler(
      new Request(
        `https://api.example.com/approvals/${encodeURIComponent(request.id)}/approve`,
        { method: "POST" },
      ),
    );
    expect(response.status).toBe(403);
  });

  it("uses the delegator's holder and relation facts", async () => {
    const store = memoryApprovalStore();
    const payer = getPermDockSync(policy, inTenant("cara", ["payer"]));
    const held = payer.decide(permissions.payment.send, {
      id: "p1",
      orgId: "o1",
    });
    if (held.outcome !== "approval-required") {
      throw new Error(held.outcome);
    }
    const request = await requestApproval(store, held, {
      permission: permissions.payment.send,
      resource: { type: "payment", id: "p1" },
      subject: payer.subject,
    });
    const source = memoryApprovalDelegationSource([
      {
        id: "hold",
        delegator: "dana",
        delegate: "erin",
        tenant: "o1",
        ...window(new Date()),
      },
    ]);
    const handler = approvalsHandler(store, {
      subject: () => inTenant("erin"),
      approvalDelegations: source,
      subjectFor: () => inTenant("dana", ["controller"]),
      permdockFor: (approver) => getPermDockSync(policy, approver),
    });
    const response = await handler(
      new Request(
        `https://api.example.com/approvals/${encodeURIComponent(request.id)}/approve`,
        { method: "POST" },
      ),
    );
    expect(response.status).toBe(200);

    const relationKey = approverRelationKey(
      relation(permissions.payment, "manager"),
    );
    const second: ApprovalRequest = {
      v: 1,
      id: "rel",
      token: "rel-token",
      permission: "payment.send",
      scope: "payment:send",
      resource: { type: "payment", id: "p2" },
      subject: { principal: { id: "cara", roles: ["reporter"], tenant: "o1" } },
      detail: "send",
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + HOUR).toISOString(),
      status: "pending",
      approvers: { by: relation(permissions.payment, "manager") },
    };
    const resolved = applyApprovalVerdict(second, {
      status: "approved",
      by: inTenant("erin"),
      onBehalfOf: {
        subject: inTenant("cfo"),
        delegation: "rel",
        relations: [relationKey],
      },
    });
    expect(resolved.approvals?.[0]).toMatchObject({
      by: "erin",
      onBehalfOf: "cfo",
      delegation: "rel",
    });
  });

  it("counts one delegator once, whichever delegate signs", () => {
    const request = {
      v: 1 as const,
      id: "quorum",
      token: "quorum",
      permission: "payment.send",
      scope: "payment:send",
      resource: { type: "payment", id: "p1" },
      subject: { principal: { id: "cara", roles: ["clerk"], tenant: "o1" } },
      detail: "send",
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + HOUR).toISOString(),
      status: "pending" as const,
      approvers: { by: user("cfo"), quorum: 2 },
      approvals: [
        {
          by: "dana",
          at: now.toISOString(),
          onBehalfOf: "cfo",
          delegation: "d1",
        },
      ],
    };
    expect(() =>
      applyApprovalVerdict(request, {
        status: "approved",
        by: inTenant("erin"),
        onBehalfOf: { subject: inTenant("cfo"), delegation: "d2" },
      }),
    ).toThrow(/already approved/u);
    expect(() =>
      applyApprovalVerdict(request, {
        status: "approved",
        by: inTenant("cfo"),
      }),
    ).toThrow(/already approved/u);
  });

  it("ignores a delegation outside its permission or resource", async () => {
    const { store, request } = await pending();
    const source = memoryApprovalDelegationSource([
      {
        id: "narrow",
        delegator: "cfo",
        delegate: "dana",
        tenant: "o1",
        permissions: ["payment.approve"],
        resources: ["invoice"],
        ...window(new Date()),
      },
    ]);
    const handler = approvalsHandler(store, {
      subject: () => inTenant("dana"),
      approvalDelegations: source,
      subjectFor: () => inTenant("cfo"),
    });
    const response = await handler(
      new Request(
        `https://api.example.com/approvals/${encodeURIComponent(request.id)}/approve`,
        { method: "POST" },
      ),
    );
    expect(response.status).toBe(403);
    expect(parseApprovalDelegation(null)).toBeUndefined();
    expect(
      parseApprovalDelegation({
        id: "d",
        delegator: "a",
        delegate: "a",
        from: "2026-10-01T00:00:00.000Z",
        until: "2026-10-02T00:00:00.000Z",
      }),
    ).toBeUndefined();
    expect(
      parseApprovalDelegation({
        id: "d",
        delegator: "a",
        delegate: "b",
        from: "2026-10-02T00:00:00.000Z",
        until: "2026-10-01T00:00:00.000Z",
      }),
    ).toBeUndefined();
    expect(
      parseApprovalDelegation({
        id: "d",
        delegator: "a",
        delegate: "b",
        permissions: [],
        from: "2026-10-01T00:00:00.000Z",
        until: "2026-10-02T00:00:00.000Z",
      }),
    ).toBeUndefined();
  });

  it("matches nobody when the source or the delegator fails", async () => {
    const request = {
      v: 1 as const,
      id: "r1",
      token: "t",
      permission: "payment.send",
      scope: "payment:send",
      resource: { type: "payment", id: "p1" },
      subject: { principal: { id: "cara", roles: ["clerk"], tenant: "o1" } },
      detail: "send",
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + HOUR).toISOString(),
      status: "pending" as const,
      approvers: { by: user("cfo") },
    };
    const factsFor = () => Promise.resolve({ relations: [], permissions: [] });
    expect(
      await matchDelegation(request, inTenant("dana"), {
        requireDistinct: true,
        factsFor,
      }),
    ).toBeUndefined();
    expect(
      await matchDelegation(
        request,
        { principal: null, context: {} },
        {
          approvalDelegations: memoryApprovalDelegationSource([]),
          subjectFor: () => inTenant("cfo"),
          requireDistinct: true,
          factsFor,
        },
      ),
    ).toBeUndefined();
    const throwing = {
      delegationsFor: () => {
        throw new Error("down");
      },
    };
    expect(
      await matchDelegation(request, inTenant("dana"), {
        approvalDelegations: throwing,
        subjectFor: () => inTenant("cfo"),
        requireDistinct: true,
        factsFor,
      }),
    ).toBeUndefined();
    const listed = {
      delegationsFor: () => [
        {
          id: "d",
          delegator: "cfo",
          delegate: "dana",
          from: "2026-10-01T00:00:00.000Z",
          until: "2026-12-31T00:00:00.000Z",
        },
      ],
    };
    expect(
      await matchDelegation(request, inTenant("dana"), {
        approvalDelegations: listed,
        subjectFor: () => null,
        requireDistinct: true,
        factsFor,
      }),
    ).toBeUndefined();
    expect(
      await matchDelegation(request, inTenant("dana"), {
        approvalDelegations: listed,
        subjectFor: () => {
          throw new Error("down");
        },
        requireDistinct: true,
        factsFor,
      }),
    ).toBeUndefined();
    expect(
      parseApprovalDelegation({
        id: "d",
        delegator: "a",
        delegate: "b",
        from: "yesterday",
        until: "2026-10-02T00:00:00.000Z",
      }),
    ).toBeUndefined();
    expect(
      parseApprovalDelegation({
        id: "d",
        delegator: "a",
        delegate: "b",
        tenant: "",
        resources: ["payment", 1],
        from: "2026-10-01T00:00:00.000Z",
        until: "2026-10-02T00:00:00.000Z",
      }),
    ).toBeUndefined();
    const source = memoryApprovalDelegationSource([
      {
        id: "open",
        delegator: "cfo",
        delegate: "dana",
        from: "2026-10-01T00:00:00.000Z",
        until: "2026-12-31T00:00:00.000Z",
      },
      {
        id: "held",
        delegator: "cfo",
        delegate: "dana",
        tenant: "other",
        from: "2026-10-01T00:00:00.000Z",
        until: "2026-12-31T00:00:00.000Z",
      },
    ]);
    expect(
      source.delegationsFor({ delegate: "dana", at: "not-a-date" }),
    ).toStrictEqual([]);
    expect(
      source.delegationsFor({
        delegate: "dana",
        at: "2026-10-13T00:00:00.000Z",
      }),
    ).toHaveLength(1);
    expect(
      source.delegationsFor({
        delegate: "dana",
        tenant: "o1",
        at: "2026-10-13T00:00:00.000Z",
      }),
    ).toHaveLength(1);
    const unscoped = {
      ...request,
      subject: { principal: { id: "cara", roles: ["clerk"] } },
    };
    expect(
      await matchDelegation(unscoped, inTenant("dana"), {
        approvalDelegations: source,
        subjectFor: () => inTenant("erin"),
        requireDistinct: true,
        factsFor,
      }),
    ).toBeUndefined();
  });

  it("refuses a contact, an outsider, a malformed answer and every entry that does not cover the request", async () => {
    const request: ApprovalRequest = {
      v: 1,
      id: "r1",
      token: "t",
      permission: "payment.send",
      scope: "payment:send",
      resource: { type: "payment", id: "p1" },
      subject: { principal: { id: "cara", roles: ["clerk"], tenant: "o1" } },
      detail: "send",
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + HOUR).toISOString(),
      status: "pending",
      approvers: { by: user("cfo") },
    };
    const factsFor = () => Promise.resolve({ relations: [], permissions: [] });
    const open = window(now);
    const match = (
      delegate: Subject,
      entries: unknown,
      subjectFor: (id: string) => Subject | null = (id) => inTenant(id),
    ) =>
      matchDelegation(request, delegate, {
        // SAFETY: a custom source may answer with anything; matchDelegation checks it.
        approvalDelegations: { delegationsFor: () => entries as never },
        subjectFor,
        requireDistinct: true,
        factsFor,
        now: { epochMilliseconds: now.getTime() },
      });
    const entry = { id: "d1", delegator: "cfo", delegate: "dana", ...open };
    expect(await match(inTenant("dana"), [entry])).toBeDefined();
    const contact: Subject = {
      principal: { id: "dana", kind: "contact", roles: [], tenant: "o1" },
      context: {},
    };
    expect(await match(contact, [entry])).toBeUndefined();
    const outsider: Subject = {
      principal: {
        id: "dana",
        roles: [],
        memberships: [{ scope: "tenant", id: "o2", roles: [] }],
      },
      context: {},
    };
    expect(await match(outsider, [entry])).toBeUndefined();
    expect(
      await match({ principal: null, context: {} }, [entry]),
    ).toBeUndefined();
    expect(await match(inTenant("dana"), { entries: [entry] })).toBeUndefined();
    const later = new Date(now.getTime() + HOUR).toISOString();
    for (const uncovered of [
      { ...entry, delegate: "erin" },
      { ...entry, delegator: "dana" },
      {
        ...entry,
        from: later,
        until: new Date(now.getTime() + 2 * HOUR).toISOString(),
      },
      { ...entry, tenant: "o2" },
      { ...entry, permissions: ["payment.approve"] },
      { ...entry, resources: ["invoice"] },
      { ...entry, resources: [1] },
    ]) {
      expect({
        uncovered,
        match: await match(inTenant("dana"), [uncovered]),
      }).toStrictEqual({ uncovered, match: undefined });
    }
    const contactDelegator = (id: string): Subject => ({
      principal: { id, kind: "contact", roles: [], tenant: "o1" },
      context: {},
    });
    expect(
      await match(inTenant("dana"), [entry], contactDelegator),
    ).toBeUndefined();
  });
});
