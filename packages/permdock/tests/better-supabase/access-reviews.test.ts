import { describe, expect, it } from "vitest";

import type { AccessReviewItem } from "../../src/approvals/access-reviews/types.ts";
import type { SupabaseRpcClient } from "../../src/supabase/postgrest.ts";

import { memoryAccessReviewStore } from "../../src/approvals/index.ts";
import { accessReviewApplier } from "../../src/better-supabase/index.ts";
import {
  allow,
  createPermDock,
  definePermissions,
  definePolicy,
  holder,
  resource,
  role,
} from "../../src/index.ts";

const ORG = "org-1";
const NOW = { epochMilliseconds: Date.parse("2026-10-14T12:00:00.000Z") };

const permissions = definePermissions({
  billing: resource({
    actions: ["view", "manage"],
    relations: { org: { field: "orgId", memberOf: "tenant" } },
  }),
});
const policy = definePolicy(permissions, {
  scopes: { tenant: { key: "orgId" } },
  roles: [
    role(
      "owner",
      [allow(permissions.billing.view), allow(permissions.billing.manage)],
      { on: "tenant" },
    ),
    role("admin", [allow(permissions.billing.manage)], { on: "tenant" }),
    role("member", [allow(permissions.billing.view)], { on: "tenant" }),
  ],
  subject: (person: { readonly id: string } | null) =>
    person === null ? null : { id: person.id },
});

type Call = { readonly fn: string; readonly args: Record<string, unknown> };
type Reply = {
  readonly data?: unknown;
  readonly error?: { message: string; hint?: string; code?: string };
};

function fakeClient(
  replies: Readonly<
    Record<string, Reply | ((args: Record<string, unknown>) => Reply)>
  > = {},
): { readonly client: SupabaseRpcClient; readonly calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    client: {
      schema(name) {
        return {
          rpc(fn, args) {
            calls.push({ fn: `${name}.${fn}`, args: { ...args } });
            const found = replies[fn];
            const reply =
              typeof found === "function" ? found({ ...args }) : found;
            return Promise.resolve({
              data: reply?.data ?? true,
              error: reply?.error ?? null,
            });
          },
        };
      },
    },
  };
}

async function reviewWith(
  holders: readonly {
    readonly principal: string;
    readonly via: readonly string[];
    readonly status: "kept" | "revoked" | "pending";
  }[],
) {
  const reviews = memoryAccessReviewStore();
  const items: AccessReviewItem[] = holders.map((entry) => ({
    v: 1,
    id: `r1:${entry.principal}:billing.manage`,
    review: "r1",
    principal: entry.principal,
    permission: "billing.manage",
    via: entry.via,
    status: "pending",
  }));
  await reviews.create(
    {
      v: 1,
      id: "r1",
      tenant: ORG,
      permissions: ["billing.manage"],
      reviewers: holder(permissions.billing.manage),
      createdBy: "boss",
      createdAt: "2026-10-01T00:00:00.000Z",
      dueAt: "2026-11-01T00:00:00.000Z",
      status: "open",
      complete: true,
    },
    items,
  );
  for (const entry of holders) {
    if (entry.status === "pending") continue;
    await reviews.decide("r1", `r1:${entry.principal}:billing.manage`, {
      status: entry.status,
      decidedBy: "boss",
      decidedAt: "2026-10-02T00:00:00.000Z",
    });
  }
  return reviews;
}

const appliedAt = async (
  reviews: Awaited<ReturnType<typeof reviewWith>>,
  principal: string,
) =>
  (await reviews.items({ review: "r1" })).items.find(
    (item) => item.principal === principal,
  )?.appliedAt;

describe("accessReviewApplier", () => {
  it("demotes to a fallback role that lacks the permission, then marks the item applied", async () => {
    const reviews = await reviewWith([
      { principal: "u1", via: ["admin"], status: "revoked" },
    ]);
    const { client, calls } = fakeClient();
    const apply = accessReviewApplier({
      client,
      reviews,
      policy,
      demoteTo: { admin: "member" },
      now: NOW,
    });
    await expect(apply("r1")).resolves.toEqual({
      applied: ["r1:u1:billing.manage"],
      failed: [],
    });
    expect(calls).toEqual([
      {
        fn: "better_supabase.update_member_role",
        args: { organization: ORG, member: "u1", role: "member" },
      },
    ]);
    expect(await appliedAt(reviews, "u1")).toBe("2026-10-14T12:00:00.000Z");
  });

  it("removes the member without a fallback, or when the fallback still grants it", async () => {
    const reviews = await reviewWith([
      { principal: "u1", via: ["owner"], status: "revoked" },
      { principal: "u2", via: ["admin"], status: "revoked" },
    ]);
    const { client, calls } = fakeClient();
    const apply = accessReviewApplier({
      client,
      reviews,
      policy,
      demoteTo: { owner: "admin" },
      schema: "app",
    });
    const result = await apply("r1");
    expect(result.applied).toHaveLength(2);
    expect(calls).toEqual([
      {
        fn: "app.remove_member",
        args: { organization: ORG, member: "u1" },
      },
      {
        fn: "app.remove_member",
        args: { organization: ORG, member: "u2" },
      },
    ]);
  });

  it("removes for a fallback role the policy does not declare", async () => {
    const reviews = await reviewWith([
      { principal: "u1", via: ["admin"], status: "revoked" },
    ]);
    const { client, calls } = fakeClient();
    await accessReviewApplier({
      client,
      reviews,
      policy,
      demoteTo: "custom-viewer",
    })("r1");
    expect(calls.map((call) => call.fn)).toEqual([
      "better_supabase.remove_member",
    ]);
  });

  it("counts a member who is already gone as applied", async () => {
    const reviews = await reviewWith([
      { principal: "u1", via: ["admin"], status: "revoked" },
      { principal: "u2", via: ["admin"], status: "revoked" },
    ]);
    const { client } = fakeClient({
      remove_member: (args) =>
        args["member"] === "u1"
          ? {
              error: {
                message: "Not a member",
                hint: "ORGANIZATION_NOT_MEMBER",
              },
            }
          : { error: { message: "Not a member", code: "P0002" } },
    });
    const result = await accessReviewApplier({ client, reviews, policy })("r1");
    expect(result).toEqual({
      applied: ["r1:u1:billing.manage", "r1:u2:billing.manage"],
      failed: [],
    });
  });

  it("leaves an item unapplied when the block refuses, and goes on", async () => {
    const reviews = await reviewWith([
      { principal: "u1", via: ["admin"], status: "revoked" },
      { principal: "u2", via: ["admin"], status: "revoked" },
    ]);
    const { client } = fakeClient({
      remove_member: (args) =>
        args["member"] === "u1"
          ? {
              error: {
                message: "That member's role is above your own",
                hint: "ORGANIZATION_ROLE_CEILING",
              },
            }
          : {},
    });
    const result = await accessReviewApplier({ client, reviews, policy })("r1");
    expect(result).toEqual({
      applied: ["r1:u2:billing.manage"],
      failed: [
        {
          item: "r1:u1:billing.manage",
          cause: "remove_member: That member's role is above your own",
        },
      ],
    });
    expect(await appliedAt(reviews, "u1")).toBeUndefined();
  });

  it("revokes open invitations to the member whose role grants the permission", async () => {
    const reviews = await reviewWith([
      { principal: "u1", via: ["admin"], status: "revoked" },
    ]);
    const { client, calls } = fakeClient({
      list_organization_invitations: {
        data: [
          { id: "i1", email: "Ann@Example.com", role: "admin" },
          { id: "i2", email: "ann@example.com", role: "member" },
          { id: "i3", email: "bob@example.com", role: "admin" },
          { id: 4, email: "ann@example.com", role: "admin" },
        ],
      },
    });
    await accessReviewApplier({
      client,
      reviews,
      policy,
      email: (id) => (id === "u1" ? "ann@example.com" : null),
    })("r1");
    expect(calls).toEqual([
      {
        fn: "better_supabase.remove_member",
        args: { organization: ORG, member: "u1" },
      },
      {
        fn: "better_supabase.list_organization_invitations",
        args: { organization: ORG },
      },
      {
        fn: "better_supabase.revoke_invitation",
        args: { invitation_id: "i1" },
      },
    ]);
  });

  it("skips invitations without an email and reads a list that is not an array as none", async () => {
    const reviews = await reviewWith([
      { principal: "u1", via: ["admin"], status: "revoked" },
      { principal: "u2", via: ["admin"], status: "revoked" },
    ]);
    const { client, calls } = fakeClient({
      list_organization_invitations: { data: { rows: [] } },
    });
    const result = await accessReviewApplier({
      client,
      reviews,
      policy,
      email: (id) => (id === "u1" ? "" : "b@example.com"),
    })("r1");
    expect(result.applied).toHaveLength(2);
    expect(calls.map((call) => call.fn)).toEqual([
      "better_supabase.remove_member",
      "better_supabase.remove_member",
      "better_supabase.list_organization_invitations",
    ]);
  });

  it("re-checks with permdockFor and keeps an item still granted unapplied", async () => {
    const reviews = await reviewWith([
      { principal: "u1", via: ["admin"], status: "revoked" },
      { principal: "u2", via: ["admin"], status: "revoked" },
    ]);
    const { client } = fakeClient();
    const result = await accessReviewApplier({
      client,
      reviews,
      policy,
      permdockFor: (id, tenant) =>
        createPermDock(policy, {
          principal: {
            id,
            tenant,
            memberships: [
              {
                scope: "tenant",
                id: tenant,
                roles: id === "u1" ? ["admin"] : ["member"],
              },
            ],
          },
          context: {},
        }),
    })("r1");
    expect(result).toEqual({
      applied: ["r1:u2:billing.manage"],
      failed: [
        {
          item: "r1:u1:billing.manage",
          cause: "u1 still holds billing.manage after the change",
        },
      ],
    });
  });

  it("keeps an item unapplied while the permission is still reachable through an approval", async () => {
    const reviews = await reviewWith([
      { principal: "u1", via: ["admin"], status: "revoked" },
    ]);
    const { client } = fakeClient();
    const behindApproval = definePolicy(permissions, {
      scopes: { tenant: { key: "orgId" } },
      roles: [
        role(
          "member",
          [allow(permissions.billing.manage, { approval: "human" })],
          { on: "tenant" },
        ),
      ],
      subject: (person: { readonly id: string } | null) =>
        person === null ? null : { id: person.id },
    });
    const result = await accessReviewApplier({
      client,
      reviews,
      policy,
      permdockFor: (id, tenant) =>
        createPermDock(behindApproval, {
          principal: {
            id,
            tenant,
            memberships: [{ scope: "tenant", id: tenant, roles: ["member"] }],
          },
          context: {},
        }),
    })("r1");
    expect(result).toEqual({
      applied: [],
      failed: [
        {
          item: "r1:u1:billing.manage",
          cause: "u1 still holds billing.manage after the change",
        },
      ],
    });
  });

  it("refuses to re-check a permission the policy lacks", async () => {
    const reviews = memoryAccessReviewStore();
    await reviews.create(
      {
        v: 1,
        id: "r1",
        tenant: ORG,
        permissions: ["gone.manage"],
        reviewers: holder(permissions.billing.manage),
        createdBy: "boss",
        createdAt: "2026-10-01T00:00:00.000Z",
        dueAt: "2026-11-01T00:00:00.000Z",
        status: "open",
        complete: true,
      },
      [
        {
          v: 1,
          id: "r1:u1:gone.manage",
          review: "r1",
          principal: "u1",
          permission: "gone.manage",
          via: [],
          status: "pending",
        },
      ],
    );
    await reviews.decide("r1", "r1:u1:gone.manage", {
      status: "revoked",
      decidedBy: "boss",
      decidedAt: "2026-10-02T00:00:00.000Z",
    });
    const { client } = fakeClient();
    const result = await accessReviewApplier({
      client,
      reviews,
      policy,
      permdockFor: (id) =>
        createPermDock(policy, { principal: { id }, context: {} }),
    })("r1");
    expect(result.failed).toEqual([
      {
        item: "r1:u1:gone.manage",
        cause:
          "gone.manage is not in the policy, so the change cannot be checked",
      },
    ]);
  });

  it("skips kept, pending and applied items, and pages through the rest", async () => {
    const holders = Array.from({ length: 60 }, (_, index) => ({
      principal: `u${String(index).padStart(2, "0")}`,
      via: ["admin"],
      status: index < 55 ? ("revoked" as const) : ("kept" as const),
    }));
    const reviews = await reviewWith([
      ...holders,
      { principal: "zz", via: ["admin"], status: "pending" },
    ]);
    await reviews.markApplied(
      "r1",
      "r1:u00:billing.manage",
      "2026-10-03T00:00:00.000Z",
    );
    const { client, calls } = fakeClient();
    const result = await accessReviewApplier({ client, reviews, policy })("r1");
    expect(result.applied).toHaveLength(54);
    expect(calls).toHaveLength(54);
    expect(await appliedAt(reviews, "u00")).toBe("2026-10-03T00:00:00.000Z");
  });

  it("throws review-not-found for an unknown review", async () => {
    const { client } = fakeClient();
    await expect(
      accessReviewApplier({
        client,
        reviews: memoryAccessReviewStore(),
        policy,
      })("missing"),
    ).rejects.toMatchObject({ code: "review-not-found" });
  });
});
