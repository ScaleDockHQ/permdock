import { describe, expect, it } from "vitest";

import type { ApprovalRequest } from "../../src/approvals/types.ts";
import type {
  BlockApprovalPolicySourceOptions,
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
  readonly tenantless: Set<string>;
  readonly deciders: (string | undefined)[];
  decide: (id: string, status: "approved" | "rejected") => void;
} {
  const records: BlockApprovalRecord<Instant>[] = [];
  const tenantless = new Set<string>();
  const deciders: (string | undefined)[] = [];
  const decided =
    (status: "approved" | "rejected") =>
    (id: string, _comment?: string, options?: { decidedBy?: string }) => {
      deciders.push(options?.decidedBy);
      const index = records.findIndex((record) => record.id === id);
      const record = records[index];
      if (record === undefined) {
        throw new Error(`no block record ${id}`);
      }
      const next = {
        ...record,
        status,
        decidedAt: instant("2026-10-28T09:45:00.000Z"),
      };
      records[index] = next;
      return ok(next);
    };
  let clock = Date.parse("2026-10-28T09:00:00Z");
  return {
    records,
    tenantless,
    deciders,
    approve: decided("approved"),
    reject: decided("rejected"),
    request(subject, input) {
      clock += 1000;
      const id = `b${records.length + 1}`;
      if (input.tenantless === true) {
        tenantless.add(id);
      }
      const record: BlockApprovalRecord<Instant> = {
        id,
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
      const scoped = records.filter(
        (record) => tenantless.has(record.id) === (options.tenantless === true),
      );
      const start =
        options.before === undefined
          ? 0
          : scoped.findIndex((record) => record.createdAt === options.before) +
            1;
      return ok(scoped.slice(start, start + (options.pageSize ?? 50)));
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

const bob: Subject = {
  principal: {
    id: "bob",
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

  it("decides through the block's approve and reject as the approver", async () => {
    const block = fakeBlock();
    const store = blockApprovalStore(block);
    const request = await openRequest(store);
    await expect(
      store.resolve(request.token, { status: "approved", by: alice }),
    ).rejects.toThrow(/principal/u);
    expect(block.deciders).toStrictEqual([]);
    const approved = await store.resolve(request.token, {
      status: "approved",
      by: bob,
    });
    expect(approved).toMatchObject({
      status: "approved",
      resolvedAt: "2026-10-28T09:45:00.000Z",
    });
    expect(block.deciders).toStrictEqual(["bob"]);
    await expect(
      store.resolve("pd1.unknown", { status: "rejected", by: bob }),
    ).rejects.toThrow("approval was not found");
    const second = await openRequest(store, approvalFingerprint("second"));
    expect(
      await store.resolve(second.token, { status: "rejected", by: bob }),
    ).toMatchObject({ status: "rejected" });
    const third = await openRequest(store, approvalFingerprint("third"));
    const stripped = blockApprovalStore({
      ...block,
      approve: (id) => {
        const record = block.records.find((item) => item.id === id);
        if (record === undefined) {
          throw new Error(`no block record ${id}`);
        }
        return ok({ ...record, status: "approved" as const, payload: {} });
      },
    });
    await expect(
      stripped.resolve(third.token, { status: "approved", by: bob }),
    ).rejects.toThrow("approval was not found");
  });

  it("files a request without a tenant tenantless and reads it back", async () => {
    const opened = await openRequest(blockApprovalStore(fakeBlock()));
    const { membership: _membership, ...rest } = opened;
    const request: ApprovalRequest = {
      ...rest,
      id: "personal",
      token: "pd1.personal",
      subject: { ...opened.subject, principal: { id: "alice", roles: [] } },
    };
    const block = fakeBlock();
    await blockApprovalStore(block, { tenantless: true }).create(request);
    expect(block.tenantless).toStrictEqual(new Set(["b1"]));
    expect(await blockApprovalStore(block).get(request.token)).toBeNull();
    const store = blockApprovalStore(block, { tenantless: true });
    expect(await store.get(request.token)).toMatchObject({ id: request.id });
    expect((await store.list({})).items).toHaveLength(1);
    const inTenant = fakeBlock();
    await openRequest(blockApprovalStore(inTenant, { tenantless: true }));
    expect(inTenant.tenantless.size).toBe(0);
  });

  it("refuses resolve without the block's approve and reject", async () => {
    const { approve: _approve, reject: _reject, ...block } = fakeBlock();
    const store = blockApprovalStore(block);
    await expect(
      store.resolve("t", { status: "approved", by: alice }),
    ).rejects.toThrow(/approve and reject on the client/u);
  });
});

function policySource(
  entries: readonly unknown[],
  options: BlockApprovalPolicySourceOptions = {},
  platformEntries: readonly unknown[] = [],
) {
  return blockApprovalPolicySource(
    {
      listPolicies: (list = {}) =>
        // SAFETY: the tests feed malformed entries on purpose.
        ok(
          (list.platform === true
            ? platformEntries
            : entries) as readonly BlockApprovalTenantPolicy[],
        ),
    },
    options,
  );
}

async function outcomes(
  source: ReturnType<typeof policySource>,
): Promise<readonly string[]> {
  const permdock = await getPermDock(policy, alice, {
    approvalPolicies: approvalPolicies(source),
  });
  return rows.expense.map(
    (row) => permdock.decide(permissions.expense.read, row).outcome,
  );
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

  const amountOver = (operator: string, value: unknown) => ({
    ...twoSteps,
    conditions: {
      id: "root",
      type: "group",
      combinator: "and",
      rules: [{ id: "r", type: "rule", path: ["amount"], operator, value }],
    },
  });

  it("applies a policy only where its payload conditions match", async () => {
    expect(
      await outcomes(policySource([amountOver("gt", 1000)])),
    ).toStrictEqual(["approval-required", "granted"]);
    expect(
      await outcomes(policySource([amountOver("gt", "1000")])),
    ).toStrictEqual(["approval-required", "granted"]);
    expect(
      await outcomes(policySource([amountOver("between", [0, 100])])),
    ).toStrictEqual(["granted", "approval-required"]);
    expect(
      await outcomes(policySource([amountOver("is_any_of", ["10"])])),
    ).toStrictEqual(["granted", "approval-required"]);
  });

  it.each([
    ["an operator PermDock has no form for", amountOver("matches", "5.*")],
    ["a date", amountOver("is_before", { date: "2026-01-01" })],
    [
      "a nested path",
      {
        ...amountOver("gt", 1000),
        conditions: {
          id: "root",
          type: "group",
          combinator: "and",
          rules: [
            {
              id: "r",
              type: "rule",
              path: ["totals", "amount"],
              operator: "gt",
              value: 1000,
            },
          ],
        },
      },
    ],
  ])("applies a policy everywhere on %s, never less", async (_label, entry) => {
    expect(await outcomes(policySource([entry]))).toStrictEqual([
      "approval-required",
      "approval-required",
    ]);
  });

  it("reads platform policies for every tenant only with platform", async () => {
    const platform = { ...twoSteps, organizationId: null };
    expect(await outcomes(policySource([], {}, [platform]))).toStrictEqual([
      "granted",
      "granted",
    ]);
    expect(
      await outcomes(policySource([], { platform: true }, [platform])),
    ).toStrictEqual(["approval-required", "approval-required"]);
    const [entry] = await policySource([], { platform: true }, [
      platform,
    ]).approvalPoliciesFor({ tenants: [] });
    expect(entry).not.toHaveProperty("tenant");
  });

  it("expands * over the permission tree and matches effects on operations", async () => {
    const every = { ...twoSteps, subjectType: "*", action: "read" };
    expect(
      await policySource([every], { permissions }).approvalPoliciesFor({
        tenants: ["o1"],
      }),
    ).toStrictEqual([
      expect.objectContaining({ permission: "report.read" }),
      expect.objectContaining({ permission: "expense.read" }),
    ]);
    expect(await outcomes(policySource([every]))).toStrictEqual([
      "denied",
      "denied",
    ]);
    const moving = { ...every, action: "*", effect: "money-movement" };
    expect(
      await policySource([moving], {
        effects: { "money-movement": ["spend"] },
      }).approvalPoliciesFor({ tenants: ["o1"] }),
    ).toStrictEqual([
      expect.objectContaining({ effects: ["spend"], tenant: "o1" }),
    ]);
    const [spend] = await policySource([
      { ...moving, effect: "spend" },
    ]).approvalPoliciesFor({ tenants: ["o1"] });
    expect(spend).not.toHaveProperty("permission");
    const [concrete] = await policySource([
      { ...twoSteps, effect: "spend" },
    ]).approvalPoliciesFor({ tenants: ["o1"] });
    expect(concrete).toMatchObject({ permission: "expense.read" });
    expect(concrete).not.toHaveProperty("effects");
  });

  it("needs every listed user for required all, and fails closed otherwise", async () => {
    const [all] = await policySource([
      {
        ...twoSteps,
        steps: [{ approvers: { users: ["a", "b"] }, required: "all" }],
      },
    ]).approvalPoliciesFor({ tenants: ["o1"] });
    expect(all?.approval).toMatchObject({ stages: [{ quorum: 2 }] });
    expect(
      await outcomes(
        policySource([
          {
            ...twoSteps,
            steps: [{ approvers: { permission: "x" }, required: "all" }],
          },
        ]),
      ),
    ).toStrictEqual(["denied", "denied"]);
  });

  const checkOf = async (entry: unknown) => {
    const [mapped] = await policySource([entry]).approvalPoliciesFor({
      tenants: ["o1"],
    });
    return mapped?.check;
  };
  const field = "amount";

  it.each([
    ["is", "a", { op: "or", conditions: [{ op: "eq", field, value: "a" }] }],
    [
      "eq",
      5,
      {
        op: "or",
        conditions: [
          { op: "eq", field, value: 5 },
          { op: "eq", field, value: "5" },
        ],
      },
    ],
    [
      "is_not",
      true,
      { op: "and", conditions: [{ op: "ne", field, value: true }] },
    ],
    ["neq", "x", { op: "and", conditions: [{ op: "ne", field, value: "x" }] }],
    ["lte", 3, { op: "lte", field, value: 3 }],
    [
      "not_between",
      ["1", 2],
      {
        op: "not",
        condition: {
          op: "and",
          conditions: [
            { op: "gte", field, value: 1 },
            { op: "lte", field, value: 2 },
          ],
        },
      },
    ],
    ["is_none_of", ["a"], { op: "notIn", field, value: ["a"] }],
    ["contains", "ab", { op: "contains", field, value: "ab" }],
    [
      "not_contains",
      "ab",
      { op: "not", condition: { op: "contains", field, value: "ab" } },
    ],
    [
      "has_any_of",
      ["a", "b"],
      {
        op: "or",
        conditions: [
          { op: "contains", field, value: "a" },
          { op: "contains", field, value: "b" },
        ],
      },
    ],
    [
      "has_all_of",
      ["a"],
      { op: "and", conditions: [{ op: "contains", field, value: "a" }] },
    ],
    [
      "has_none_of",
      ["a"],
      {
        op: "not",
        condition: {
          op: "or",
          conditions: [{ op: "contains", field, value: "a" }],
        },
      },
    ],
    ["empty", undefined, { op: "isNull", field, value: true }],
    ["not_empty", undefined, { op: "isNull", field, value: false }],
  ])("maps the %s operator", async (operator, value, expected) => {
    expect(await checkOf(amountOver(operator, value))).toStrictEqual({
      op: "and",
      conditions: [expected],
    });
  });

  it.each([
    ["is", { a: 1 }],
    ["is_not", null],
    ["gt", "many"],
    ["between", [1]],
    ["between", "1..2"],
    ["is_any_of", []],
    ["contains", 1],
    ["not_contains", 1],
    ["has_any_of", "a"],
  ])("drops %s with the value %j", async (operator, value) => {
    expect(await checkOf(amountOver(operator, value))).toBeUndefined();
  });

  it("combines groups, negation and unfinished rules as the block does", async () => {
    const rule = (operator: string, negated?: boolean) => ({
      id: operator,
      type: "rule",
      path: ["amount"],
      operator,
      value: 1,
      ...(negated === undefined ? {} : { negated }),
    });
    const tree = (combinator: string, rules: readonly unknown[]) => ({
      ...twoSteps,
      conditions: { id: "root", type: "group", combinator, rules },
    });
    expect(await checkOf(tree("or", [rule("gt"), rule("")]))).toBeUndefined();
    expect(await checkOf(tree("and", [rule("")]))).toBeUndefined();
    expect(await checkOf(tree("and", [rule("", true)]))).toBeUndefined();
    expect(
      await checkOf(tree("and", [rule("gt", true), rule("")])),
    ).toStrictEqual({
      op: "and",
      conditions: [
        { op: "not", condition: { op: "gt", field: "amount", value: 1 } },
      ],
    });
    expect(
      await checkOf(tree("or", [tree("and", [rule("lt")]).conditions])),
    ).toStrictEqual({
      op: "or",
      conditions: [
        { op: "and", conditions: [{ op: "lt", field: "amount", value: 1 }] },
      ],
    });
    for (const broken of [
      tree("xor", []),
      tree("and", ["rule"]),
      tree("and", [{ type: "rule", path: ["amount"], operator: 1 }]),
      { ...twoSteps, conditions: { type: "other" } },
    ]) {
      expect(await checkOf(broken)).toBeUndefined();
    }
    expect(await checkOf({ ...twoSteps, conditions: null })).toBeUndefined();
  });

  it("reads an effect mapped to nothing as no effect", async () => {
    const entry = { ...twoSteps, action: "*", effect: "audit" };
    await expect(
      policySource([entry], { effects: { audit: [] } }).approvalPoliciesFor({
        tenants: ["o1"],
      }),
    ).rejects.toThrow("needs blockApprovalPolicySource's permissions");
  });
});
