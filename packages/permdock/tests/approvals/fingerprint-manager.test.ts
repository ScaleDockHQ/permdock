import { approvalFingerprint as blockFingerprint } from "better-supabase/blocks/approvals";
import { describe, expect, it } from "vitest";

import type { ApprovalRequest } from "../../src/approvals/index.ts";
import type { Decision } from "../../src/core/decision.ts";
import type { RelationSource } from "../../src/core/interfaces.ts";
import type { Subject } from "../../src/core/subject.ts";

import {
  approvalFingerprint,
  consumeApproval,
  memoryApprovalStore,
  resolveApproval,
  resumeDecision,
} from "../../src/approvals/index.ts";
import { describe as describeDecision } from "../../src/core/describe.ts";
import {
  allow,
  definePermissions,
  definePolicy,
  getPermDockSync,
  manager,
  normalizeApproval,
  resource,
  role,
} from "../../src/index.ts";

const permissions = definePermissions({
  invoice: resource({ actions: ["pay"] }),
});

const policy = definePolicy(permissions, {
  roles: [
    role("clerk", [allow(permissions.invoice.pay, { approval: "human" })]),
  ],
  subject: (user: { readonly id: string; readonly roles: readonly string[] }) =>
    user,
});

const clerk = { id: "u_1", roles: ["clerk"] };
const reviewer: Subject = { principal: { id: "u_9", roles: [] }, context: {} };

const operation = { invoice: "inv_1", amount: 100, to: "acct_7" };

async function resume(
  store: ReturnType<typeof memoryApprovalStore>,
  fingerprint: string | undefined,
  token: string | undefined,
): Promise<{ readonly decision: Decision; readonly resumed: Decision }> {
  const permdock = getPermDockSync(policy, clerk);
  const decision = permdock.decide(
    permissions.invoice.pay,
    { id: "inv_1" },
    fingerprint === undefined ? {} : { fingerprint },
  );
  const resumed = await resumeDecision({
    decision,
    permission: permissions.invoice.pay,
    subject: permdock.subject,
    store,
    resource: { type: "invoice", id: "inv_1" },
    adapter: "test",
    token,
  });
  return { decision, resumed };
}

describe(approvalFingerprint, () => {
  it("matches better-supabase's approvalFingerprint", async () => {
    for (const value of [
      operation,
      { b: [1, undefined, { d: "x", c: null }], a: "é" },
      "plain",
      42,
      null,
    ]) {
      expect(approvalFingerprint(value)).toBe(await blockFingerprint(value));
    }
    expect(approvalFingerprint(operation)).toMatch(/^[0-9a-f]{64}$/u);
  });
});

describe("approval fingerprints", () => {
  it("binds the token and records the fingerprint on the request", async () => {
    const store = memoryApprovalStore();
    const fingerprint = approvalFingerprint(operation);
    const plain = await resume(store, undefined, undefined);
    const bound = await resume(store, fingerprint, undefined);
    expect(bound.decision).toMatchObject({
      outcome: "approval-required",
      fingerprint,
    });
    const token =
      bound.decision.outcome === "approval-required"
        ? bound.decision.token
        : "";
    expect(plain.decision.outcome === "approval-required" && token).not.toBe(
      plain.decision.outcome === "approval-required" && plain.decision.token,
    );
    expect((await store.get(token))?.fingerprint).toBe(fingerprint);
  });

  it("resumes under the same fingerprint and refuses another", async () => {
    const store = memoryApprovalStore();
    const fingerprint = approvalFingerprint(operation);
    const { decision } = await resume(store, fingerprint, undefined);
    const token =
      decision.outcome === "approval-required" ? decision.token : "";
    await resolveApproval(store, token, { status: "approved", by: reviewer });

    const other = approvalFingerprint({ ...operation, amount: 900 });
    const swapped = await resume(store, other, token);
    expect(swapped.resumed.outcome).toBe("approval-required");

    const resumed = await resume(store, fingerprint, token);
    expect(resumed.resumed.outcome).toBe("granted");
  });

  it("consumes a fingerprinted request only under its fingerprint", async () => {
    const store = memoryApprovalStore();
    const fingerprint = approvalFingerprint(operation);
    const { decision } = await resume(store, fingerprint, undefined);
    const token =
      decision.outcome === "approval-required" ? decision.token : "";
    await resolveApproval(store, token, { status: "approved", by: reviewer });
    await expect(consumeApproval(store, token)).resolves.toStrictEqual({
      ok: false,
      cause: "approval-fingerprint-mismatch",
    });
    await expect(
      consumeApproval(store, token, undefined, { fingerprint }),
    ).resolves.toMatchObject({ ok: true });
  });

  it("denies a resume whose decision carries no fingerprint for a fingerprinted request", async () => {
    const store = memoryApprovalStore();
    const fingerprint = approvalFingerprint(operation);
    const { decision } = await resume(store, fingerprint, undefined);
    const token =
      decision.outcome === "approval-required" ? decision.token : "";
    await resolveApproval(store, token, { status: "approved", by: reviewer });
    if (decision.outcome !== "approval-required") {
      throw new Error("expected approval-required");
    }
    const { fingerprint: _bound, ...unbound } = decision;
    const permdock = getPermDockSync(policy, clerk);
    const resumed = await resumeDecision({
      decision: unbound,
      permission: permissions.invoice.pay,
      subject: permdock.subject,
      store,
      resource: { type: "invoice", id: "inv_1" },
      adapter: "test",
      token,
    });
    expect(resumed).toMatchObject({
      outcome: "denied",
      denials: [
        { reason: "approval", detail: "approval-fingerprint-mismatch" },
      ],
    });
  });
});

function managerChain(chain: Readonly<Record<string, string>>): RelationSource {
  return {
    ancestors: () => ({ ancestors: [] }),
    related: ({ resource: type, id, relation }) => {
      const boss = chain[id];
      return type === "user" && relation === "manager" && boss !== undefined
        ? [{ principal: { id: boss } }]
        : [];
    },
  };
}

function pendingFor(
  approvers: NonNullable<ApprovalRequest["approvers"]>,
): ApprovalRequest {
  return {
    v: 1,
    id: "r1",
    token: "pd1.manager",
    permission: "invoice.pay",
    scope: "invoice:pay",
    resource: { type: "invoice", id: "inv_1" },
    subject: { principal: { id: "u_1", roles: ["clerk"] } },
    approvers,
    detail: "invoice.pay requires approval.",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    status: "pending",
  };
}

const person = (id: string): Subject => ({
  principal: { id, roles: [] },
  context: {},
});

describe(manager, () => {
  const relations = managerChain({ u_1: "u_2", u_2: "u_3", u_3: "u_4" });

  it("approves through the requester's direct manager only by default", async () => {
    const store = memoryApprovalStore();
    await store.create(pendingFor({ by: manager() }));
    await expect(
      resolveApproval(
        store,
        "pd1.manager",
        { status: "approved", by: person("u_3") },
        { relations },
      ),
    ).rejects.toMatchObject({ code: "approver-not-eligible" });
    await expect(
      resolveApproval(
        store,
        "pd1.manager",
        { status: "approved", by: person("u_2") },
        { relations },
      ),
    ).resolves.toMatchObject({ status: "approved", resolvedBy: "u_2" });
  });

  it("walks up to levels managers", async () => {
    const store = memoryApprovalStore();
    await store.create(pendingFor({ by: manager({ levels: 2 }) }));
    await expect(
      resolveApproval(
        store,
        "pd1.manager",
        { status: "approved", by: person("u_4") },
        { relations },
      ),
    ).rejects.toMatchObject({ code: "approver-not-eligible" });
    await expect(
      resolveApproval(
        store,
        "pd1.manager",
        { status: "approved", by: person("u_3") },
        { relations },
      ),
    ).resolves.toMatchObject({ status: "approved" });
  });

  it("matches nobody without a relation source or when the read fails", async () => {
    const failing: RelationSource = {
      ancestors: () => ({ ancestors: [] }),
      related: () => {
        throw new Error("down");
      },
    };
    for (const options of [{}, { relations: failing }]) {
      const store = memoryApprovalStore();
      await store.create(pendingFor({ by: manager() }));
      await expect(
        resolveApproval(
          store,
          "pd1.manager",
          { status: "approved", by: person("u_2") },
          options,
        ),
      ).rejects.toMatchObject({ code: "approver-not-eligible" });
    }
  });

  it("validates levels, normalises through approval.by and labels the approver", () => {
    expect(() => manager({ levels: 0 })).toThrow(/levels/u);
    expect(() => manager({ levels: 9 })).toThrow(/levels/u);
    expect(() => manager({ levels: 1.5 })).toThrow(/levels/u);
    expect(manager({ levels: 1 })).toStrictEqual({ kind: "manager" });
    expect(normalizeApproval({ by: manager({ levels: 3 }) })).toMatchObject({
      by: { kind: "manager", levels: 3 },
    });
    const managed = definePolicy(permissions, {
      roles: [
        role("clerk", [
          allow(permissions.invoice.pay, { approval: { by: manager() } }),
        ]),
      ],
      subject: (user: {
        readonly id: string;
        readonly roles: readonly string[];
      }) => user,
    });
    const decision = getPermDockSync(managed, clerk).decide(
      permissions.invoice.pay,
      { id: "inv_1" },
    );
    expect(describeDecision(decision).detail).toContain(
      "the requester's manager",
    );
  });
});
