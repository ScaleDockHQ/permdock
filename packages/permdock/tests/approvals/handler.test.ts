import { describe, expect, it } from "vitest";

import type {
  ApprovalRequest,
  ApprovalStore,
} from "../../src/approvals/index.ts";
import type { Subject } from "../../src/core/subject.ts";

import {
  ApprovalError,
  approvalsHandler,
  memoryApprovalStore,
} from "../../src/approvals/index.ts";

const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const BASE = "https://api.example.com/permdock/approvals";

function pending(
  token: string,
  principal: ApprovalRequest["subject"]["principal"],
): ApprovalRequest {
  return {
    v: 1,
    id: token,
    token: `pd1.${token}`,
    permission: "post.delete",
    scope: "post:delete",
    resource: { type: "post", id: "42" },
    subject: { principal },
    detail: "post.delete requires human approval.",
    createdAt: new Date().toISOString(),
    expiresAt: future,
    status: "pending",
  };
}

function seeded(): ApprovalStore {
  const store = memoryApprovalStore();
  void store.create(
    pending("own", { id: "u_1", roles: ["member"], tenant: "o_1" }),
  );
  void store.create(
    pending("acme", { id: "u_2", roles: ["member"], tenant: "o_acme" }),
  );
  void store.create(pending("loose", { id: "u_3", roles: ["member"] }));
  void store.create(pending("anon", null));
  return store;
}

const viewer: Subject = {
  principal: {
    id: "u_1",
    roles: [],
    memberships: [{ scope: "tenant", id: "o_1", roles: ["admin"] }],
  },
  context: {},
};

describe("approvalsHandler GET by id", () => {
  it.each<[string, number]>([
    ["own", 200],
    ["acme", 404],
    ["loose", 200],
    ["anon", 200],
    ["missing", 404],
  ])("shows %s with %d", async (id, status) => {
    const handler = approvalsHandler(seeded(), { subject: () => viewer });
    expect((await handler(new Request(`${BASE}/${id}`))).status).toBe(status);
  });

  it("hides a tenantless request from a principal who may not resolve it", async () => {
    const store = memoryApprovalStore();
    void store.create({
      ...pending("closed", { id: "u_3", roles: ["member"] }),
      approvers: { by: { kind: "user", id: "u_8" } },
    });
    const as = (id: string, roles: string[]): Subject => ({
      principal: { id, roles },
      context: {},
    });
    const statusFor = async (subject: Subject) =>
      (
        await approvalsHandler(store, { subject: () => subject })(
          new Request(`${BASE}/closed`),
        )
      ).status;
    expect(await statusFor(as("u_9", ["member"]))).toBe(404);
    expect(await statusFor(as("u_3", ["member"]))).toBe(200);
    expect(await statusFor(as("u_8", ["member"]))).toBe(200);
  });

  it("keeps a resolved tenantless request visible to who resolved it", async () => {
    const store = memoryApprovalStore();
    void store.create({
      ...pending("done", { id: "u_3", roles: ["member"] }),
      approvers: { by: { kind: "user", id: "u_8" } },
    });
    const approver: Subject = {
      principal: { id: "u_8", roles: [] },
      context: {},
    };
    const handler = approvalsHandler(store, { subject: () => approver });
    const { status } = await handler(
      new Request(`${BASE}/done/approve`, { method: "POST" }),
    );
    expect(status).toBe(200);
    expect((await handler(new Request(`${BASE}/done`))).status).toBe(200);
  });

  it("refuses a note over 2000 characters and a body over 16 KiB", async () => {
    const store = seeded();
    const handler = approvalsHandler(store, { subject: () => viewer });
    const post = (body: string, headers: Record<string, string> = {}) =>
      handler(
        new Request(`${BASE}/loose/approve`, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body,
        }),
      );
    const { status } = await post(JSON.stringify({ note: "x".repeat(2001) }));
    expect(status).toBe(400);
    expect(
      (await post("{}", { "content-length": String(16 * 1024 + 1) })).status,
    ).toBe(413);
    expect((await store.get("pd1.loose"))?.status).toBe("pending");
    expect(
      (await post(JSON.stringify({ note: "x".repeat(2000) }))).status,
    ).toBe(200);
  });

  it("refuses an undefined subject, a wrong method and an unknown path", async () => {
    const handler = approvalsHandler(seeded(), { subject: () => undefined });
    const { status } = await handler(new Request(`${BASE}/own`));
    expect(status).toBe(401);
    const wrong = await handler(
      new Request(`${BASE}/own`, { method: "DELETE" }),
    );
    expect([wrong.status, wrong.headers.get("allow")]).toStrictEqual([
      405,
      "GET",
    ]);
    const post = await handler(new Request(`${BASE}/own/approve`));
    expect([post.status, post.headers.get("allow")]).toStrictEqual([
      405,
      "POST",
    ]);
    const unknown = await handler(new Request("https://api.example.com/"));
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ type: "about:blank" });
    expect(
      (
        await handler(
          new Request(`${BASE}/%E0%A4%A/approve`, { method: "POST" }),
        )
      ).status,
    ).toBe(404);
  });
});

describe("approvalsHandler error mapping", () => {
  it.each<[ApprovalError["code"], number]>([
    ["approval-not-found", 404],
    ["approval-not-pending", 409],
    ["approval-expired", 409],
    ["approver-unauthenticated", 401],
    ["approver-not-eligible", 403],
  ])("maps %s to %d", async (code, status) => {
    const store: ApprovalStore = {
      ...seeded(),
      resolve: () => {
        throw new ApprovalError(code, code);
      },
    };
    const handler = approvalsHandler(store, { subject: () => viewer });
    const response = await handler(
      new Request(`${BASE}/loose/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ note: 7 }),
      }),
    );
    expect(response.status).toBe(status);
  });

  it("ignores an unreadable note", async () => {
    const handler = approvalsHandler(seeded(), { subject: () => viewer });
    const response = await handler(
      new Request(`${BASE}/loose/reject`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{nope",
      }),
    );
    expect(response.status).toBe(200);
  });
});

describe("approvalsHandler inbox", () => {
  it("lists across membership tenants for a principal without an active tenant and pages", async () => {
    const store = seeded();
    const handler = approvalsHandler(store, {
      subject: () => ({
        principal: {
          id: "u_9",
          roles: [],
          memberships: [{ scope: "tenant", id: "o_acme", roles: ["admin"] }],
        },
        context: {},
      }),
    });
    const response = await handler(new Request(`${BASE}/pending?limit=1`));
    // SAFETY: response JSON produced by approvalsHandler's pending route under test.
    const body = (await response.json()) as {
      readonly items: readonly ApprovalRequest[];
      readonly next?: string;
    };
    expect({
      status: response.status,
      paged: body.items.length <= 1,
      next: typeof body.next,
    }).toStrictEqual({ status: 200, paged: true, next: "string" });
    const next = new URL(`${BASE}/pending?limit=1`);
    next.searchParams.set("cursor", body.next ?? "");
    expect(response.headers.get("link")).toBe(`<${next.href}>; rel="next"`);
    expect(body.items.every((item) => !("token" in item))).toBe(true);
  });
});

describe("approvalsHandler HTTP semantics", () => {
  const approver: Subject = {
    principal: { id: "u_8", roles: [] },
    context: {},
  };

  function closed(): ApprovalStore {
    const store = memoryApprovalStore();
    void store.create({
      ...pending("closed", { id: "u_3", roles: ["member"] }),
      approvers: { by: { kind: "user", id: "u_8" } },
    });
    return store;
  }

  it("never shows the resume token and tags the view with a strong ETag", async () => {
    const handler = approvalsHandler(closed(), { subject: () => approver });
    const response = await handler(new Request(`${BASE}/closed`));
    const etag = response.headers.get("etag");
    expect(etag).toMatch(/^"sha-256:[\w-]+"$/u);
    expect(await response.json()).not.toHaveProperty("token");
    const cached = await handler(
      new Request(`${BASE}/closed`, {
        headers: { "if-none-match": `W/${etag ?? ""}` },
      }),
    );
    expect([cached.status, cached.headers.get("etag")]).toStrictEqual([
      304,
      etag,
    ]);
  });

  it("answers 412 when If-Match names another version", async () => {
    const store = closed();
    const handler = approvalsHandler(store, { subject: () => approver });
    const etag =
      (await handler(new Request(`${BASE}/closed`))).headers.get("etag") ?? "";
    const stale = await handler(
      new Request(`${BASE}/closed/approve`, {
        method: "POST",
        headers: { "if-match": `"sha-256:other", W/${etag}` },
      }),
    );
    expect(stale.status).toBe(412);
    expect((await store.get("pd1.closed"))?.status).toBe("pending");
    const fresh = await handler(
      new Request(`${BASE}/closed/approve`, {
        method: "POST",
        headers: { "if-match": etag },
      }),
    );
    expect(fresh.status).toBe(200);
    expect(fresh.headers.get("etag")).not.toBe(etag);
  });

  it("matches If-Match: *", async () => {
    const handler = approvalsHandler(closed(), { subject: () => approver });
    const response = await handler(
      new Request(`${BASE}/closed/reject`, {
        method: "POST",
        headers: { "if-match": "*" },
      }),
    );
    expect(response.status).toBe(200);
  });

  it("replays an Idempotency-Key and refuses it for another request", async () => {
    const handler = approvalsHandler(closed(), { subject: () => approver });
    const approve = (key: string, note: string) =>
      handler(
        new Request(`${BASE}/closed/approve`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "idempotency-key": key,
          },
          body: JSON.stringify({ note }),
        }),
      );
    const first = await approve('"k-1"', "ok");
    const retry = await approve('"k-1"', "ok");
    expect([first.status, retry.status]).toStrictEqual([200, 200]);
    expect(await retry.json()).toStrictEqual(await first.json());
    expect(retry.headers.get("etag")).toBe(first.headers.get("etag"));
    const reused = await approve('"k-1"', "changed");
    expect(reused.status).toBe(422);
    const { status } = await approve('"k-2"', "ok");
    expect(status).toBe(409);
    expect((await approve("k-3", "ok")).status).toBe(400);
    expect((await approve(`"${"k".repeat(257)}"`, "ok")).status).toBe(400);
  });

  it("serves the signed approval as an application/jwt sub-resource", async () => {
    const handler = approvalsHandler(closed(), {
      subject: () => approver,
      audience: "https://api.example.com",
      signer: {
        sign: (_claims, options) =>
          Promise.resolve(`signed.${options.jti ?? ""}`),
      },
    });
    const { status } = await handler(new Request(`${BASE}/closed/signature`));
    expect(status).toBe(404);
    const approved = await handler(
      new Request(`${BASE}/closed/approve`, { method: "POST" }),
    );
    expect(approved.headers.get("link")).toBe(
      `<${BASE}/closed/signature>; rel="alternate"; type="application/jwt"`,
    );
    expect(await approved.json()).not.toHaveProperty("signed");
    const signature = await handler(new Request(`${BASE}/closed/signature`));
    expect([
      signature.status,
      signature.headers.get("content-type"),
      await signature.text(),
    ]).toStrictEqual([200, "application/jwt", "signed.closed"]);
    expect(
      (await handler(new Request(`${BASE}/missing/signature`))).status,
    ).toBe(404);
  });

  it("serves the signature to an earlier quorum approver and not to a stranger, and 404s an undecodable id", async () => {
    const store = memoryApprovalStore();
    void store.create({
      ...pending("quorum", { id: "u_3", roles: ["member"] }),
      status: "approved",
      approvals: [
        { by: "u_7", at: new Date().toISOString() },
        { by: "u_9", at: new Date().toISOString() },
      ],
      resolvedBy: "u_9",
      resolvedAt: new Date().toISOString(),
    });
    const as = (id: string) =>
      approvalsHandler(store, {
        subject: () => ({ principal: { id, roles: [] }, context: {} }),
        audience: "https://api.example.com",
        signer: {
          sign: (_claims, options) =>
            Promise.resolve(`signed.${options.jti ?? ""}`),
        },
      });
    const signature = (id: string) =>
      as(id)(new Request(`${BASE}/quorum/signature`));
    expect((await signature("u_7")).status).toBe(200);
    expect((await signature("u_5")).status).toBe(404);
    expect((await as("u_7")(new Request(`${BASE}/%E0%A4%A`))).status).toBe(404);
  });

  it("types an ineligible approver as approver-not-eligible", async () => {
    const handler = approvalsHandler(closed(), {
      subject: () => ({
        principal: { id: "u_3", roles: ["member"] },
        context: {},
      }),
    });
    const response = await handler(
      new Request(`${BASE}/closed/approve`, { method: "POST" }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      type: "https://permdock.com/problems/approver-not-eligible",
    });
  });

  it("finds a request by id in a store without getById", async () => {
    const inner = closed();
    const store: ApprovalStore = {
      create: (request) => inner.create(request),
      get: (token) => inner.get(token),
      resolve: (token, verdict) => inner.resolve(token, verdict),
      list: (query) => inner.list(query),
      expire: (now) => inner.expire(now),
      consume: (token, now) => inner.consume(token, now),
    };
    const handler = approvalsHandler(store, { subject: () => approver });
    const { status } = await handler(new Request(`${BASE}/closed`));
    expect(status).toBe(200);
    expect((await handler(new Request(`${BASE}/nope`))).status).toBe(404);
  });
});
