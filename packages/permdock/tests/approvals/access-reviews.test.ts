import { describe, expect, it } from "vitest";

import type { MembershipSource } from "../../src/core/interfaces.ts";
import type { Subject } from "../../src/core/subject.ts";

import { AccessReviewError } from "../../src/approvals/access-reviews/errors.ts";
import {
  accessReviewsHandler,
  decideAccessReviewItem,
  isAccessReviewError,
  memoryAccessReviewStore,
  pageAccessReviewItems,
  startAccessReview,
} from "../../src/approvals/index.ts";
import {
  allow,
  createPermDock,
  definePermissions,
  definePolicy,
  holder,
  resource,
  role,
  user,
} from "../../src/index.ts";
import { testAccessReviewStore } from "../../src/testing/index.ts";

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
      {
        on: "tenant",
      },
    ),
    role("member", [allow(permissions.billing.view)], { on: "tenant" }),
    role("platform", [allow(permissions.billing.manage)]),
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

const memberships: MembershipSource = {
  membershipsFor: () => [],
  list: () => [
    {
      principal: { id: "ann" },
      membership: { scope: "tenant", id: "o1", roles: ["owner"] },
    },
    {
      principal: { id: "ben" },
      membership: { scope: "tenant", id: "o1", roles: ["member"] },
    },
  ],
};

describe("access reviews", () => {
  testAccessReviewStore(memoryAccessReviewStore());

  it("lists members a rowless decide confirms, and marks global roles incomplete", async () => {
    const opener = await createPermDock(policy, inTenant("ann", ["owner"]));
    const store = memoryAccessReviewStore();
    const review = await startAccessReview(
      opener,
      {
        id: "q4",
        permissions: [permissions.billing.view, permissions.billing.manage],
        reviewers: user("ann"),
        dueAt: "2026-12-31T00:00:00.000Z",
      },
      {
        reviews: store,
        memberships,
        policy,
        permdockFor: (id) =>
          createPermDock(
            policy,
            inTenant(id, id === "ann" ? ["owner"] : ["member"]),
          ),
      },
    );
    expect(review.complete).toBe(false);
    const page = await store.items({ review: "q4" });
    expect(page.items.map((item) => [item.principal, item.permission])).toEqual(
      [
        ["ann", "billing.manage"],
        ["ann", "billing.view"],
        ["ben", "billing.view"],
      ],
    );
  });

  it("uses a supplied holder list and refuses a reviewer deciding their own row", async () => {
    const opener = await createPermDock(policy, inTenant("ann", ["owner"]));
    const store = memoryAccessReviewStore();
    const review = await startAccessReview(
      opener,
      {
        id: "holders",
        permissions: [permissions.billing.manage],
        reviewers: holder(permissions.billing.manage),
        dueAt: "2026-12-31T00:00:00.000Z",
      },
      {
        reviews: store,
        holders: [
          { principal: "ann", permission: "billing.manage", via: ["owner"] },
          { principal: "ben", permission: "billing.manage", via: ["owner"] },
        ],
        complete: true,
      },
    );
    expect(review.complete).toBe(true);
    const [own, other] = (await store.items({ review: "holders" })).items;
    if (own === undefined || other === undefined) {
      throw new Error("expected two items");
    }
    expect(() =>
      decideAccessReviewItem(review, own, {
        status: "kept",
        by: inTenant("ann", ["owner"]),
        permissions: ["billing.manage"],
      }),
    ).toThrow(/own access/u);
    const decision = decideAccessReviewItem(review, other, {
      status: "revoked",
      by: inTenant("ann", ["owner"]),
      permissions: ["billing.manage"],
    });
    expect(decision).toMatchObject({ status: "revoked", decidedBy: "ann" });
    const handler = accessReviewsHandler(store, {
      subject: () => inTenant("ann", ["owner"]),
      permdockFor: (reviewer) => createPermDock(policy, reviewer),
    });
    const response = await handler(
      new Request(
        `https://api.example.com/access-reviews/holders/${encodeURIComponent(other.id)}/revoke`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ note: "left the team" }),
        },
      ),
    );
    expect(response.status).toBe(200);
    const applied = await handler(
      new Request(
        `https://api.example.com/access-reviews/holders/${encodeURIComponent(other.id)}/applied`,
        { method: "POST" },
      ),
    );
    expect(applied.status).toBe(200);
    expect(await applied.json()).toMatchObject({
      status: "revoked",
      appliedAt: expect.any(String),
    });
  });

  it("hides a review from someone who is not a reviewer", async () => {
    const opener = await createPermDock(policy, inTenant("ann", ["owner"]));
    const store = memoryAccessReviewStore();
    await startAccessReview(
      opener,
      {
        id: "secret",
        permissions: [permissions.billing.view],
        reviewers: user("ann"),
        dueAt: "2026-12-31T00:00:00.000Z",
      },
      {
        reviews: store,
        holders: [
          { principal: "ben", permission: "billing.view", via: ["member"] },
        ],
      },
    );
    const handler = accessReviewsHandler(store, {
      subject: () => inTenant("ben", ["member"]),
    });
    const response = await handler(
      new Request("https://api.example.com/access-reviews/secret"),
    );
    expect(response.status).toBe(404);
  });

  it("records keep and close, and maps the refusal codes", async () => {
    expect(isAccessReviewError(new Error("no"))).toBe(false);
    expect(
      isAccessReviewError(
        new AccessReviewError("review-closed", "access review is closed"),
      ),
    ).toBe(true);
    expect(
      isAccessReviewError(
        Object.assign(new Error("x"), {
          name: "AccessReviewError",
          code: "review-closed",
        }),
      ),
    ).toBe(true);
    expect(
      isAccessReviewError(
        Object.assign(new Error("x"), {
          name: "AccessReviewError",
          code: "nope",
        }),
      ),
    ).toBe(false);
    const opener = await createPermDock(policy, inTenant("ann", ["owner"]));
    const store = memoryAccessReviewStore();
    await expect(
      startAccessReview(
        await createPermDock(policy, { principal: null, context: {} }),
        {
          id: "none",
          permissions: [permissions.billing.view],
          reviewers: user("ann"),
          dueAt: "2026-12-31T00:00:00.000Z",
        },
        { reviews: store, holders: [] },
      ),
    ).rejects.toThrow(/tenant/u);
    await expect(
      startAccessReview(
        opener,
        {
          id: "bad",
          permissions: [],
          reviewers: user("ann"),
          dueAt: "not-a-date",
        },
        { reviews: store, holders: [] },
      ),
    ).rejects.toThrow(/permissions/u);
    const review = await startAccessReview(
      opener,
      {
        id: "round",
        permissions: [permissions.billing.view],
        reviewers: user("ann"),
        dueAt: "2026-12-31T00:00:00.000Z",
      },
      {
        reviews: store,
        holders: [
          { principal: "ben", permission: "billing.view", via: ["member"] },
          { principal: "ben", permission: "billing.view", via: ["member"] },
          { principal: "", permission: "billing.view", via: [] },
          { principal: "ben", permission: "billing.manage", via: ["owner"] },
        ],
      },
    );
    expect((await store.items({ review: "round" })).items).toHaveLength(1);
    const item = (await store.items({ review: "round" })).items[0];
    if (item === undefined) {
      throw new Error("expected an item");
    }
    const handler = accessReviewsHandler(store, {
      subject: (request) =>
        request.headers.get("x-user") === "none"
          ? null
          : inTenant("ann", ["owner"]),
    });
    const base = "https://api.example.com/access-reviews/round";
    expect((await handler(new Request(base))).status).toBe(200);
    expect((await handler(new Request(`${base}/items`))).status).toBe(200);
    expect(
      (
        await handler(
          new Request(`${base}/${encodeURIComponent(item.id)}/keep`, {
            method: "POST",
          }),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await handler(
          new Request(`${base}/${encodeURIComponent(item.id)}/applied`, {
            method: "POST",
          }),
        )
      ).status,
    ).toBe(409);
    expect(
      (await handler(new Request(`${base}/close`, { method: "POST" }))).status,
    ).toBe(200);
    expect(
      (
        await handler(
          new Request(`${base}/${encodeURIComponent(item.id)}/revoke`, {
            method: "POST",
          }),
        )
      ).status,
    ).toBe(409);
    expect(await store.get("missing")).toBeNull();
    expect(
      (
        await handler(
          new Request("https://api.example.com/access-reviews/missing"),
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await handler(
          new Request(base, {
            headers: { authorization: "Bearer x", "x-user": "none" },
          }),
        )
      ).status,
    ).toBe(401);
    expect(
      (await handler(new Request("https://api.example.com/access-reviews")))
        .status,
    ).toBe(404);
    expect(review.status).toBe("open");
  });

  it("refuses a closed review, a stray item and a listing that throws", async () => {
    const opener = await createPermDock(policy, inTenant("ann", ["owner"]));
    const store = memoryAccessReviewStore();
    const review = await startAccessReview(
      opener,
      {
        id: "edges",
        permissions: [permissions.billing.view],
        reviewers: user("ann"),
        dueAt: "2026-12-31T00:00:00.000Z",
      },
      {
        reviews: store,
        holders: [
          { principal: "ben", permission: "billing.view", via: ["member"] },
        ],
      },
    );
    expect(store.reviews().map((entry) => entry.id)).toEqual(["edges"]);
    expect(await store.items({ review: "missing" })).toEqual({ items: [] });
    const [item] = (await store.items({ review: "edges", status: "pending" }))
      .items;
    if (item === undefined) {
      throw new Error("expected an item");
    }
    const stray = { ...item, review: "other" };
    expect(() =>
      decideAccessReviewItem(review, stray, {
        status: "kept",
        by: inTenant("ann", ["owner"]),
      }),
    ).toThrow(/belong/u);
    expect(() =>
      decideAccessReviewItem(review, item, {
        status: "kept",
        by: { principal: null, context: {} },
      }),
    ).toThrow(/authenticated/u);
    expect(() =>
      decideAccessReviewItem(review, item, {
        status: "kept",
        by: inTenant("cara", ["member"]),
      }),
    ).toThrow(/eligible/u);
    await store.decide("edges", item.id, {
      status: "revoked",
      decidedBy: "ann",
      decidedAt: "2026-10-14T00:00:00.000Z",
      note: "gone",
    });
    await expect(
      Promise.resolve().then(() =>
        store.decide("edges", "missing", {
          status: "kept",
          decidedBy: "ann",
          decidedAt: "2026-10-14T00:00:00.000Z",
        }),
      ),
    ).rejects.toThrow(/not found/u);
    const applied = await store.markApplied(
      "edges",
      item.id,
      "2026-10-15T00:00:00.000Z",
    );
    expect(applied.appliedAt).toBe("2026-10-15T00:00:00.000Z");
    await expect(
      Promise.resolve().then(() =>
        store.markApplied("edges", item.id, "2026-10-16T00:00:00.000Z"),
      ),
    ).rejects.toThrow(/already/u);
    expect(() =>
      store.create(review, [{ ...item, review: "elsewhere" }]),
    ).not.toThrow();
    const fresh = memoryAccessReviewStore();
    expect(() =>
      fresh.create({ ...review, id: "fresh" }, [
        { ...item, id: "x", review: "elsewhere" },
      ]),
    ).toThrow(/belong/u);
    const broken: MembershipSource = {
      membershipsFor: () => [],
      list: () => {
        throw new Error("down");
      },
    };
    const incomplete = await startAccessReview(
      opener,
      {
        id: "down",
        permissions: [permissions.billing.view],
        reviewers: user("ann"),
        dueAt: "2026-12-31T00:00:00.000Z",
      },
      { reviews: fresh, memberships: broken, policy },
    );
    expect(incomplete.complete).toBe(false);
    expect(await fresh.items({ review: "down" })).toEqual({ items: [] });
    expect(() =>
      decideAccessReviewItem(
        review,
        { ...item, status: "kept" },
        { status: "revoked", by: inTenant("ann", ["owner"]) },
      ),
    ).toThrow(/decided/u);
    expect(() =>
      decideAccessReviewItem(review, item, {
        status: "kept",
        by: {
          principal: { id: "link-1", kind: "link", roles: [], memberships: [] },
          context: {},
        },
      }),
    ).toThrow(/eligible/u);
  });

  it("rejects an unknown route, a missing item and a store that throws", async () => {
    const opener = await createPermDock(policy, inTenant("ann", ["owner"]));
    const store = memoryAccessReviewStore();
    await startAccessReview(
      opener,
      {
        id: "http",
        permissions: [permissions.billing.view],
        reviewers: user("ann"),
        dueAt: "2026-12-31T00:00:00.000Z",
      },
      {
        reviews: store,
        holders: [
          { principal: "ben", permission: "billing.view", via: ["member"] },
        ],
      },
    );
    const handler = accessReviewsHandler(store, {
      subject: (request) => {
        if (request.headers.get("x-throw") === "1") {
          throw new Error("down");
        }
        return inTenant("ann", ["owner"]);
      },
    });
    expect(
      (await handler(new Request("https://api.example.com/"))).status,
    ).toBe(404);
    const post = await handler(
      new Request("https://api.example.com/access-reviews/http", {
        method: "POST",
      }),
    );
    expect([post.status, post.headers.get("allow")]).toEqual([405, "GET"]);
    expect(
      (
        await handler(
          new Request("https://api.example.com/access-reviews/http", {
            headers: { "x-throw": "1" },
          }),
        )
      ).status,
    ).toBe(401);
    const keep = await handler(
      new Request("https://api.example.com/access-reviews/http/missing/keep", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{",
      }),
    );
    expect(keep.status).toBe(404);
    const broken = accessReviewsHandler(
      {
        ...store,
        get: () => {
          throw new Error("down");
        },
      },
      { subject: () => inTenant("ann", ["owner"]) },
    );
    expect(
      (await broken(new Request("https://api.example.com/access-reviews/http")))
        .status,
    ).toBe(500);
    expect(await store.items({ review: "http", cursor: "nope" })).toEqual({
      items: [],
    });
    const [only] = (await store.items({ review: "http" })).items;
    if (only === undefined) {
      throw new Error("expected an item");
    }
    const paged = pageAccessReviewItems(
      [only, { ...only, id: "http:cara:billing.view", principal: "cara" }],
      { review: "http", limit: 1 },
    );
    if (paged.next === undefined) {
      throw new Error("expected a next cursor");
    }
    expect(
      pageAccessReviewItems(
        [only, { ...only, id: "http:cara:billing.view", principal: "cara" }],
        { review: "http", cursor: paged.next },
      ).items,
    ).toHaveLength(1);
    await expect(
      Promise.resolve().then(() =>
        store.decide("missing", "missing", {
          status: "kept",
          decidedBy: "ann",
          decidedAt: "2026-10-14T00:00:00.000Z",
        }),
      ),
    ).rejects.toThrow(/not found/u);
    await expect(
      Promise.resolve().then(() =>
        store.markApplied("http", "missing", "2026-10-14T00:00:00.000Z"),
      ),
    ).rejects.toThrow(/not found/u);
  });
});
