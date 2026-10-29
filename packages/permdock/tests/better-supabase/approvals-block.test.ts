import { describe, expect, it } from "vitest";

import type { ApprovalRequest } from "../../src/approvals/types.ts";
import type {
  BlockApprovalRecord,
  BlockApprovalsClient,
  BlockApprovalTenantPolicy,
  BlockInstant,
} from "../../src/better-supabase/approvals-block.ts";
import type { Subject } from "../../src/core/subject.ts";

import { requestApproval } from "../../src/approvals/helpers.ts";
import {
  blockApprovalPolicySource,
  blockApprovalStore,
} from "../../src/better-supabase/index.ts";
import { approvalPolicies } from "../../src/core/approval-policies.ts";
import { getPermDock } from "../../src/core/permdock.ts";
import { approvalFingerprint } from "../../src/core/token.ts";
import { permissions, policy, rows } from "../fixtures/expenses.ts";

function firstExpense(): NonNullable<(typeof rows.expense)[number]> {
  const [row] = rows.expense;
  if (row === undefined) {
    throw new Error("the expenses fixture has no rows");
  }
  return row;
}

const large = firstExpense();

type Instant = BlockInstant & { readonly at: string };
const instant = (at: string): Instant => ({ at, toJSON: () => at });
const ok = <T>(data: T) =>
  Promise.resolve({ ok: true as const, data, error: null });

/** An in-memory approvals block: the calls the bridge makes and a decide hook. */
function fakeBlock(): BlockApprovalsClient<Instant> & {
  readonly records: BlockApprovalRecord<Instant>[];
  decide: (id: string, status: "approved" | "rejected") => void;
} {
  const records: BlockApprovalRecord<Instant>[] = [];
  let clock = Date.parse("2026-10-28T09:00:00Z");
  return {
    records,
    request(subject, input) {
      clock += 1000;
      const record: BlockApprovalRecord<Instant> = {
        id: `b${records.length + 1}`,
        status: "pending",
        payload: input.payload ?? {},
        ...(input.fingerprint === undefined
          ? {}
          : { fingerprint: input.fingerprint }),
        createdAt: instant(new Date(clock).toISOString()),
      };
      expect(subject.type).toBe("expense");
      records.unshift(record);
      return ok(record);
    },
    list(options = {}) {
      const start =
        options.before === undefined
          ? 0
          : records.findIndex((record) => record.createdAt === options.before) +
            1;
      return ok(records.slice(start, start + (options.pageSize ?? 50)));
    },
    consume(id, fingerprint) {
      const index = records.findIndex((record) => record.id === id);
      const record = records[index];
      if (
        record?.status !== "approved" ||
        record.consumedAt !== undefined ||
        (record.fingerprint !== undefined && record.fingerprint !== fingerprint)
      ) {
        return Promise.resolve({
          ok: false as const,
          data: null,
          error: { kind: "conflict" },
        });
      }
      const consumed = {
        ...record,
        consumedAt: instant("2026-10-28T10:00:00.000Z"),
      };
      records[index] = consumed;
      return ok(consumed);
    },
    decide(id, status) {
      const index = records.findIndex((record) => record.id === id);
      const record = records[index];
      if (record !== undefined) {
        records[index] = {
          ...record,
          status,
          decidedAt: instant("2026-10-28T09:30:00.000Z"),
        };
      }
    },
  };
}

const alice: Subject = {
  principal: {
    id: "alice",
    tenant: "o1",
    memberships: [{ scope: "tenant", id: "o1", roles: ["member"] }],
  },
  context: {},
};

async function openRequest(
  store: ReturnType<typeof blockApprovalStore>,
  fingerprint?: string,
): Promise<ApprovalRequest> {
  const permdock = await getPermDock(policy, alice, {
    approvalPolicies: approvalPolicies({
      approvalPoliciesFor: () => [
        { permission: "expense.read", approval: "human" },
      ],
    }),
  });
  const decision = permdock.decide(
    permissions.expense.read,
    large,
    fingerprint === undefined ? {} : { fingerprint },
  );
  if (decision.outcome !== "approval-required") {
    throw new Error(`expected approval-required, got ${decision.outcome}`);
  }
  return requestApproval(store, decision, {
    permission: permissions.expense.read,
    resource: { type: "expense", id: large.id },
    subject: alice,
  });
}

describe(blockApprovalStore, () => {
  it("files a block request and reads it back by token and id", async () => {
    const block = fakeBlock();
    const store = blockApprovalStore(block);
    const request = await openRequest(store);
    expect(block.records[0]).toMatchObject({
      payload: { permdock: { token: request.token } },
    });
    expect(await store.get(request.token)).toMatchObject({
      id: request.id,
      status: "pending",
    });
    expect(await store.getById?.(request.id)).toMatchObject({
      token: request.token,
    });
    expect(await store.get("pd1.unknown")).toBeNull();
  });

  it("follows the block's decision and consumes once under the fingerprint", async () => {
    const block = fakeBlock();
    const store = blockApprovalStore(block);
    const fingerprint = approvalFingerprint({ expense: large.id });
    const request = await openRequest(store, fingerprint);
    expect(block.records[0]?.fingerprint).toBe(fingerprint);
    block.decide("b1", "approved");
    expect(await store.get(request.token)).toMatchObject({
      status: "approved",
      resolvedAt: "2026-10-28T09:30:00.000Z",
    });
    expect(await store.consume(request.token)).toMatchObject({
      consumedAt: "2026-10-28T10:00:00.000Z",
    });
    expect(await store.consume(request.token)).toBeNull();
  });

  it("maps a cancelled request to rejected and pages list oldest first", async () => {
    const block = fakeBlock();
    const store = blockApprovalStore(block);
    const first = await openRequest(store);
    const [opened] = block.records;
    if (opened !== undefined) {
      block.records[0] = { ...opened, status: "cancelled" };
    }
    await openRequest(store, approvalFingerprint("second"));
    const page = await store.list({ limit: 1 });
    expect(page.items.map((item) => item.id)).toStrictEqual([first.id]);
    expect(page.items[0]?.status).toBe("rejected");
    expect(page.next).toBe("1");
    expect(
      (await store.list({ status: "pending" })).items.map((item) => item.id),
    ).toHaveLength(1);
  });

  it("refuses resolve, since approvers decide through the block", () => {
    const store = blockApprovalStore(fakeBlock());
    expect(() => store.resolve("t", { status: "approved", by: alice })).toThrow(
      /decided through the approvals block/u,
    );
  });
});

function policySource(entries: readonly unknown[]) {
  return blockApprovalPolicySource({
    listPolicies: () =>
      // SAFETY: the tests feed malformed entries on purpose.
      ok(entries as readonly BlockApprovalTenantPolicy[]),
  });
}

const twoSteps: BlockApprovalTenantPolicy = {
  organizationId: "o1",
  subjectType: "expense",
  action: "read",
  mode: "authorize",
  steps: [
    { approvers: { manager: true }, required: 1 },
    { approvers: { role: "finance", users: ["cfo"] }, required: 2 },
  ],
  selfApproval: false,
  expiresIn: "3 days",
  enabled: true,
};

describe(blockApprovalPolicySource, () => {
  it("maps tenant policies to sequential stages for the subject's tenants", async () => {
    const source = policySource([
      twoSteps,
      { ...twoSteps, organizationId: "o2" },
      { ...twoSteps, enabled: false },
    ]);
    expect(await source.approvalPoliciesFor({ tenants: ["o1"] })).toStrictEqual(
      [
        {
          permission: "expense.read",
          tenant: "o1",
          approval: {
            stages: [
              { by: { kind: "any-of", of: [{ kind: "manager" }] }, quorum: 1 },
              {
                by: {
                  kind: "any-of",
                  of: [
                    { kind: "role", role: "finance", scope: "tenant" },
                    { kind: "user", id: "cfo" },
                  ],
                },
                quorum: 2,
              },
            ],
            combine: "sequential",
            ttl: 259_200,
          },
        },
      ],
    );
  });

  it("throws when listPolicies fails or answers no list", async () => {
    const failing = blockApprovalPolicySource({
      listPolicies: async () => ({ ok: false, error: new Error("down") }),
    });
    await expect(
      failing.approvalPoliciesFor({ tenants: ["o1"] }),
    ).rejects.toThrow("the approvals block's listPolicies failed");
    const empty = blockApprovalPolicySource({
      // SAFETY: a block that breaks its contract; the source must reject it.
      listPolicies: async () => ({ ok: true, data: null as never }),
    });
    await expect(
      empty.approvalPoliciesFor({ tenants: ["o1"] }),
    ).rejects.toThrow("listPolicies answered no list");
  });

  it("lets the principal confirm only when the policy is confirm with selfApproval", async () => {
    const one = { ...twoSteps, steps: [], expiresIn: undefined };
    const [confirm] = await policySource([
      { ...one, mode: "confirm", selfApproval: true },
    ]).approvalPoliciesFor({ tenants: ["o1"] });
    const [loose] = await policySource([
      { ...one, mode: "confirm", selfApproval: false },
    ]).approvalPoliciesFor({ tenants: ["o1"] });
    expect(confirm?.approval).toStrictEqual({ mode: "confirm" });
    expect(loose?.approval).toStrictEqual({});
  });

  it("requires approval through PermDock wherever the block would", async () => {
    const permdock = await getPermDock(policy, alice, {
      approvalPolicies: approvalPolicies(policySource([twoSteps])),
    });
    expect(permdock.decide(permissions.expense.read, large)).toMatchObject({
      outcome: "approval-required",
    });
  });

  it.each([
    [
      "a team-only step",
      { steps: [{ approvers: { team: "t" }, required: 1 }] },
    ],
    ["an unreadable interval", { expiresIn: "1 day 02:00:00" }],
  ])("fails closed on %s", async (_label, change) => {
    const permdock = await getPermDock(policy, alice, {
      approvalPolicies: approvalPolicies(
        policySource([{ ...twoSteps, ...change }]),
      ),
    });
    expect(permdock.decide(permissions.expense.read, large)).toMatchObject({
      outcome: "denied",
      denials: [{ reason: "approval" }],
    });
  });
});
