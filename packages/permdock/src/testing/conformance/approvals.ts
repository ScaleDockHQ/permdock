import { expect, it } from "vitest";

import type {
  AccessReviewStore,
  ApprovalDelegationSource,
  ApprovalRequest,
  ApprovalStore,
  IdempotencyStore,
  IdempotentResponse,
} from "../../approvals/index.ts";
import type { ApprovalPolicySource, Policy, Subject } from "../../index.ts";

import { approvalPoliciesFor } from "../../core/approval-policies.ts";

function sampleApproval(token: string): ApprovalRequest {
  return {
    v: 1,
    id: `apr_${token}`,
    token,
    permission: "post.delete",
    scope: "post:delete",
    resource: { type: "post", id: "42" },
    subject: {
      principal: { id: "u_1", roles: ["member"] },
      actor: { id: "agent-1", kind: "eve" },
    },
    detail: "post.delete requires human approval.",
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    status: "pending",
  };
}

const approver: Subject = {
  principal: { id: "u_9", roles: ["admin"] },
  context: {},
};

const secondApprover: Subject = {
  principal: { id: "u_10", roles: ["admin"] },
  context: {},
};

const admin = {
  kind: "role" as const,
  role: "admin",
  scope: "global" as const,
};

export type ApprovalStoreOptions = {
  /**
   * Opens a second store over the same backing storage, as a restarted process
   * would. Omit it for stores that do not persist (the resume-after-restart
   * case is then skipped).
   */
  readonly reopen?: () => ApprovalStore | Promise<ApprovalStore>;
};

function tenantApproval(token: string, tenant: string): ApprovalRequest {
  const base = sampleApproval(token);
  return {
    ...base,
    subject: {
      ...base.subject,
      principal: { id: "u_1", roles: ["member"], tenant },
    },
  };
}

function tenantApprover(tenant: string): Subject {
  return {
    principal: {
      id: "u_9",
      roles: [],
      memberships: [{ tenant, roles: ["admin"] }],
    },
    context: {},
  };
}

export function testApprovalStore(
  store: ApprovalStore,
  options: ApprovalStoreOptions = {},
): void {
  it("keeps the existing record when the same call asks again", async () => {
    await store.create(sampleApproval("dup-token"));
    await store.resolve("dup-token", { status: "approved", by: approver });
    await store.create(sampleApproval("dup-token"));
    expect((await store.get("dup-token"))?.status).toBe("approved");
  });

  it("consumes an approved request exactly once", async () => {
    await store.create(sampleApproval("once-token"));
    expect(await store.consume("once-token")).toBeNull();
    await store.resolve("once-token", { status: "approved", by: approver });
    const [first, second] = await Promise.all([
      store.consume("once-token"),
      store.consume("once-token"),
    ]);
    expect([first, second].filter((item) => item !== null)).toHaveLength(1);
    expect((first ?? second)?.consumedAt).toEqual(expect.any(String));
    expect(await store.consume("once-token")).toBeNull();
    expect((await store.get("once-token"))?.consumedAt).toEqual(
      expect.any(String),
    );
  });

  it("refuses an approver from another tenant", async () => {
    await store.create(tenantApproval("tenant-token", "o_1"));
    await expect(
      Promise.resolve().then(() =>
        store.resolve("tenant-token", {
          status: "approved",
          by: tenantApprover("o_2"),
        }),
      ),
    ).rejects.toThrow(/tenant|eligible/u);
    expect((await store.get("tenant-token"))?.status).toBe("pending");
  });

  it.skipIf(options.reopen === undefined)(
    "resumes an approval after a restart",
    async () => {
      await store.create(sampleApproval("restart-token"));
      await store.resolve("restart-token", {
        status: "approved",
        by: approver,
      });
      const reopened = await options.reopen!();
      expect((await reopened.get("restart-token"))?.status).toBe("approved");
      expect(await reopened.consume("restart-token")).not.toBeNull();
      expect(await store.consume("restart-token")).toBeNull();
    },
  );

  it("creates, gets, lists, resolves and expires", async () => {
    const request = sampleApproval("opaque-token");
    await store.create(request);
    const loaded = await store.get("opaque-token");
    expect(loaded).toEqual(request);
    expect(JSON.parse(JSON.stringify(loaded))).toEqual(request);
    const listed = await store.list({ status: "pending" });
    expect(listed.items.some((item) => item.token === "opaque-token")).toBe(
      true,
    );
    const resolved = await store.resolve("opaque-token", {
      status: "approved",
      by: approver,
    });
    expect(resolved.status).toBe("approved");
    await expect(
      Promise.resolve().then(() =>
        store.resolve("opaque-token", { status: "rejected", by: approver }),
      ),
    ).rejects.toThrow(/not pending/);
    await store.create(sampleApproval("stale-token"));
    const expired = await store.expire({
      epochMilliseconds: Date.now() + 2 * 60 * 60 * 1000,
    });
    expect(expired).toBeGreaterThanOrEqual(1);
  });

  it("pages list results with limit and an opaque cursor", async () => {
    const base = Date.parse("2026-01-01T00:00:00.000Z");
    const tokens = ["page-a", "page-b", "page-c"];
    await Promise.all(
      tokens.map(async (token, index) =>
        store.create({
          ...sampleApproval(token),
          subject: { principal: { id: "u_pager", roles: ["member"] } },
          createdAt: new Date(base + index * 1000).toISOString(),
        }),
      ),
    );
    const first = await store.list({ principalId: "u_pager", limit: 2 });
    expect(first.items.map((item) => item.token)).toEqual(["page-a", "page-b"]);
    expect(typeof first.next).toBe("string");
    const second = await store.list({
      principalId: "u_pager",
      limit: 2,
      cursor: first.next!,
    });
    expect(second.items.map((item) => item.token)).toEqual(["page-c"]);
    expect(second.next).toBeUndefined();
    expect(
      (await store.list({ principalId: "u_pager", cursor: "not a cursor" }))
        .items,
    ).toEqual([]);
  });

  it("refuses an approver who does not match request.approvers", async () => {
    const request = {
      ...sampleApproval("gated-token"),
      approvers: {
        by: { kind: "role" as const, role: "admin", scope: "global" as const },
      },
    };
    await store.create(request);
    const member: Subject = {
      principal: { id: "u_2", roles: ["member"] },
      context: {},
    };
    await expect(
      Promise.resolve().then(() =>
        store.resolve("gated-token", { status: "approved", by: member }),
      ),
    ).rejects.toThrow(/eligible|not pending|not found/);
  });

  it("refuses the principal as approver unless the grant sets distinct: false", async () => {
    const principal: Subject = {
      principal: { id: "u_1", roles: ["admin"] },
      context: {},
    };
    const shapes = [
      ["self-human", undefined],
      ["self-by", { by: admin }],
      ["self-distinct", { by: admin, distinct: true }],
    ] as const;
    for (const [token, approvers] of shapes) {
      await store.create(
        approvers === undefined
          ? sampleApproval(token)
          : { ...sampleApproval(token), approvers },
      );
      await expect(
        Promise.resolve().then(() =>
          store.resolve(token, { status: "approved", by: principal }),
        ),
      ).rejects.toThrow(/principal/u);
      expect((await store.get(token))?.status).toBe("pending");
    }
    await store.create({
      ...sampleApproval("self-optout"),
      approvers: { by: admin, distinct: false },
    });
    const resolved = await store.resolve("self-optout", {
      status: "approved",
      by: principal,
    });
    expect(resolved.resolvedBy).toBe("u_1");
  });

  it("stays pending until the quorum is met and counts an approver once", async () => {
    await store.create({
      ...sampleApproval("quorum-token"),
      approvers: { by: admin, quorum: 2 },
    });
    const first = await store.resolve("quorum-token", {
      status: "approved",
      by: approver,
    });
    expect(first.status).toBe("pending");
    expect(first.approvals).toEqual([{ by: "u_9", at: expect.any(String) }]);
    expect(await store.consume("quorum-token")).toBeNull();
    await expect(
      Promise.resolve().then(() =>
        store.resolve("quorum-token", { status: "approved", by: approver }),
      ),
    ).rejects.toThrow(/already approved/u);
    const second = await store.resolve("quorum-token", {
      status: "approved",
      by: secondApprover,
    });
    expect(second.status).toBe("approved");
    expect(second.approvals?.map((item) => item.by)).toEqual(["u_9", "u_10"]);
    expect(second.resolvedBy).toBe("u_10");
    expect(await store.consume("quorum-token")).not.toBeNull();
  });

  it("resolves a vouched verdict at once, records its rule, and still refuses the requester", async () => {
    await store.create({
      ...sampleApproval("vouched-token"),
      approvers: { by: admin, quorum: 2 },
    });
    await expect(
      Promise.resolve().then(() =>
        store.resolve("vouched-token", {
          status: "approved",
          by: { principal: { id: "u_1", roles: [] }, context: {} },
          vouched: "app-rule",
        }),
      ),
    ).rejects.toThrow(/principal/u);
    const resolved = await store.resolve("vouched-token", {
      status: "approved",
      by: { principal: { id: "u_outsider", roles: [] }, context: {} },
      vouched: "app-rule",
    });
    expect(resolved.status).toBe("approved");
    expect(resolved.vouched).toBe("app-rule");
    expect(resolved.approvals).toEqual([
      { by: "u_outsider", at: expect.any(String), vouched: "app-rule" },
    ]);
  });

  it("lets one rejection end a quorum request", async () => {
    await store.create({
      ...sampleApproval("veto-token"),
      approvers: { by: admin, quorum: 2 },
    });
    const rejected = await store.resolve("veto-token", {
      status: "rejected",
      by: approver,
    });
    expect(rejected.status).toBe("rejected");
    expect(rejected.approvals).toBeUndefined();
  });

  it("admits the escalation grantee only once the request has waited", async () => {
    const auditor: Subject = {
      principal: { id: "u_11", roles: ["auditor"] },
      context: {},
    };
    const escalation = {
      after: 3600,
      to: { kind: "role" as const, role: "auditor", scope: "global" as const },
    };
    await store.create({
      ...sampleApproval("fresh-escalation"),
      approvers: { by: admin, escalation },
    });
    await expect(
      Promise.resolve().then(() =>
        store.resolve("fresh-escalation", { status: "approved", by: auditor }),
      ),
    ).rejects.toThrow(/eligible/u);
    await store.create({
      ...sampleApproval("waited-escalation"),
      createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      approvers: { by: admin, escalation },
    });
    const resolved = await store.resolve("waited-escalation", {
      status: "approved",
      by: auditor,
    });
    expect(resolved.status).toBe("approved");
    expect(resolved.resolvedBy).toBe("u_11");
  });

  it("completes sequential stages in order and records each stage", async () => {
    await store.create({
      ...sampleApproval("stages-token"),
      approvers: {
        mode: "sequential",
        stages: [{ by: { kind: "user", id: "u_10" } }, { by: admin }],
      },
    });
    await expect(
      Promise.resolve().then(() =>
        store.resolve("stages-token", { status: "approved", by: approver }),
      ),
    ).rejects.toThrow(/eligible/u);
    const first = await store.resolve("stages-token", {
      status: "approved",
      by: secondApprover,
    });
    expect(first.status).toBe("pending");
    expect(first.approvals).toEqual([
      { by: "u_10", at: expect.any(String), stage: 0 },
    ]);
    const second = await store.resolve("stages-token", {
      status: "approved",
      by: approver,
    });
    expect(second.status).toBe("approved");
    expect(second.approvals?.map((item) => item.stage)).toEqual([0, 1]);
  });

  it("matches a relation approver only through the verdict's relations", async () => {
    const manager = {
      kind: "relation" as const,
      resource: "post",
      relation: "manager",
    };
    await store.create({
      ...sampleApproval("relation-token"),
      approvers: { by: manager },
    });
    await expect(
      Promise.resolve().then(() =>
        store.resolve("relation-token", { status: "approved", by: approver }),
      ),
    ).rejects.toThrow(/eligible/u);
    const resolved = await store.resolve("relation-token", {
      status: "approved",
      by: approver,
      relations: [JSON.stringify(["post", "manager", null, null])],
    });
    expect(resolved.status).toBe("approved");
  });
}

/**
 * Checks an `ApprovalPolicySource`: entries are plain JSON, belong to the
 * queried tenant or to none, and every entry loads against `policy` (an
 * entry that does not would deny every call).
 */
export function testApprovalPolicySource(
  source: ApprovalPolicySource,
  options: {
    readonly policy: Policy;
    readonly tenant: string;
    readonly unknown?: string;
  },
): void {
  it("answers per tenant with plain entries that load against the policy", async () => {
    const entries = await source.approvalPoliciesFor({
      tenants: [options.tenant],
    });
    expect(Array.isArray(entries)).toBe(true);
    for (const entry of entries) {
      expect(JSON.parse(JSON.stringify(entry))).toEqual(entry);
      expect([undefined, options.tenant]).toContain(entry.tenant);
    }
    const loaded = await approvalPoliciesFor(
      options.policy,
      source,
      [options.tenant],
      [],
    );
    expect(loaded).not.toBe("failed");
    const other = await source.approvalPoliciesFor({
      tenants: [options.unknown ?? "__permdock_unknown__"],
    });
    expect(other.filter((entry) => entry.tenant !== undefined)).toEqual([]);
  });
}

const reviewItem = {
  v: 1 as const,
  id: "rev:u_1:post.delete",
  review: "rev",
  principal: "u_1",
  permission: "post.delete",
  via: ["member"],
  status: "pending" as const,
};

/**
 * Checks an `AccessReviewStore`: create is kept, items page, a decision is
 * recorded once, only a revoked item can be marked applied, and close is once.
 */
export function testAccessReviewStore(store: AccessReviewStore): void {
  it("records a review, pages its items and stores one decision", async () => {
    const review = {
      v: 1 as const,
      id: "rev",
      tenant: "o1",
      permissions: ["post.delete"],
      reviewers: { kind: "user" as const, id: "u_9" },
      createdBy: "u_owner",
      createdAt: "2026-10-13T12:00:00.000Z",
      dueAt: "2026-12-31T00:00:00.000Z",
      status: "open" as const,
      complete: true,
    };
    await store.create(review, [
      reviewItem,
      { ...reviewItem, id: "rev:u_2:post.delete", principal: "u_2" },
    ]);
    await store.create(review, []);
    expect((await store.get("rev"))?.status).toBe("open");
    const page = await store.items({ review: "rev", limit: 1 });
    expect(page.items).toHaveLength(1);
    expect(page.next).toEqual(expect.any(String));
    const kept = await store.decide("rev", reviewItem.id, {
      status: "kept",
      decidedBy: "u_9",
      decidedAt: "2026-10-14T12:00:00.000Z",
    });
    expect(kept.status).toBe("kept");
    await expect(
      Promise.resolve().then(() =>
        store.decide("rev", reviewItem.id, {
          status: "revoked",
          decidedBy: "u_9",
          decidedAt: "2026-10-14T12:00:00.000Z",
        }),
      ),
    ).rejects.toThrow(/decided/u);
    const revoked = await store.decide("rev", "rev:u_2:post.delete", {
      status: "revoked",
      decidedBy: "u_9",
      decidedAt: "2026-10-14T12:00:00.000Z",
    });
    expect(revoked.status).toBe("revoked");
    await expect(
      Promise.resolve().then(() =>
        store.markApplied("rev", reviewItem.id, "2026-10-15T00:00:00.000Z"),
      ),
    ).rejects.toThrow(/revoked/u);
    const applied = await store.markApplied(
      "rev",
      "rev:u_2:post.delete",
      "2026-10-15T00:00:00.000Z",
    );
    expect(applied.appliedAt).toBe("2026-10-15T00:00:00.000Z");
    expect((await store.close("rev")).status).toBe("closed");
    await expect(
      Promise.resolve().then(() => store.close("rev")),
    ).rejects.toThrow(/closed/u);
  });
}

/**
 * Checks an `ApprovalDelegationSource`: entries are plain JSON, name the
 * delegate, and are active at `at`. A query for another delegate is empty.
 */
export function testApprovalDelegationSource(
  source: ApprovalDelegationSource,
  options: {
    readonly delegate: string;
    readonly delegator: string;
    readonly tenant?: string;
    readonly at?: string;
  },
): void {
  it("answers with active plain delegations for the delegate", async () => {
    const at = options.at ?? new Date().toISOString();
    const entries = await source.delegationsFor({
      delegate: options.delegate,
      ...(options.tenant === undefined ? {} : { tenant: options.tenant }),
      at,
    });
    expect(Array.isArray(entries)).toBe(true);
    expect(
      entries.some(
        (entry) =>
          entry.delegate === options.delegate &&
          entry.delegator === options.delegator,
      ),
    ).toBe(true);
    const instant = Date.parse(at);
    for (const entry of entries) {
      expect(JSON.parse(JSON.stringify(entry))).toEqual(entry);
      expect(entry.delegate).toBe(options.delegate);
      expect(Date.parse(entry.from)).toBeLessThanOrEqual(instant);
      expect(Date.parse(entry.until)).toBeGreaterThan(instant);
    }
    expect(
      await source.delegationsFor({
        delegate: "__permdock_unknown__",
        ...(options.tenant === undefined ? {} : { tenant: options.tenant }),
        at,
      }),
    ).toEqual([]);
  });
}

/**
 * Checks an `IdempotencyStore`: a stored response comes back as written
 * until it expires, keys never share an entry, and a later `set` replaces an
 * earlier one.
 */
export function testIdempotencyStore(store: IdempotencyStore): void {
  it("replays a stored response per key and keeps keys apart", async () => {
    const key = `u_1\n${crypto.randomUUID()}`;
    const other = `u_2\n${crypto.randomUUID()}`;
    const response: IdempotentResponse = {
      fingerprint: "approve apr_1 sha-256:abc",
      status: 200,
      headers: [["content-type", "application/json"]],
      body: '{"status":"approved"}',
    };
    const later = Date.now() + 60 * 60 * 1000;
    expect(await store.get(key)).toBeUndefined();
    await store.set(key, response, later);
    expect(await store.get(key)).toEqual(response);
    expect(await store.get(other)).toBeUndefined();
    const replaced = { ...response, status: 201 };
    await store.set(key, replaced, later);
    expect(await store.get(key)).toEqual(replaced);
  });
}
