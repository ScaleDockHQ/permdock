import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Decision } from "../../src/core/decision.ts";
import type { Snapshot, TokenVerifier } from "../../src/core/interfaces.ts";

import { createClientStore } from "../../src/client/store.ts";
import { emptySnapshot } from "../../src/core/from-snapshot.ts";
import { createPermDock } from "../../src/core/permdock.ts";
import {
  memberUser,
  ownPost,
  permissions,
  policy,
} from "../fixtures/quick-start.ts";

// SAFETY: a partial approval-required decision; the store reads only outcome, grant and token.
const required: Decision = {
  outcome: "approval-required",
  grant: {
    permission: "post.publish",
    role: "member",
    approval: { by: ["editor"] },
  },
  token: "pd1.token/one",
} as unknown as Decision;

function signedIn(id: string): Snapshot {
  return {
    ...emptySnapshot(),
    subject: { principal: { id, roles: [] }, context: {} },
  };
}

function ignore(): void {
  return undefined;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status });
}

describe("createClientStore approvals", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("polls the approvals handler until the request resolves", async () => {
    const urls: string[] = [];
    const statuses = ["pending", "pending", "approved"];
    const store = createClientStore({
      snapshot: signedIn("u1"),
      approvals: "/api/approvals",
      server: false,
      fetch: (input) => {
        urls.push(String(input));
        return Promise.resolve(
          json({ status: statuses.shift() ?? "approved" }),
        );
      },
    });
    const stop = store.subscribe(() => undefined);
    expect(store.approvalState(required)).toBe("required");
    await vi.advanceTimersByTimeAsync(2000);
    expect(store.approvalState(required)).toBe("pending");
    await vi.advanceTimersByTimeAsync(4000);
    expect(store.approvalState(required)).toBe("approved");
    const calls = urls.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(urls).toHaveLength(calls);
    expect(urls[0]).toBe("/api/approvals/pd1.token%2Fone");
    stop();
  });

  it("stops polling when nothing subscribes and after clear", async () => {
    let calls = 0;
    const store = createClientStore({
      snapshot: signedIn("u1"),
      approvals: "/api/approvals",
      server: false,
      fetch: () => {
        calls += 1;
        return Promise.resolve(json({ status: "pending" }));
      },
    });
    const stop = store.subscribe(() => undefined);
    store.approvalState(required);
    await vi.advanceTimersByTimeAsync(2000);
    expect(calls).toBe(1);
    store.get().clear();
    expect(store.approvalState(required)).toBe("required");
    stop();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toBe(1);
  });

  it("never polls without an approvals URL or while rendering on the server", async () => {
    let calls = 0;
    const fetch = (): Promise<Response> => {
      calls += 1;
      return Promise.resolve(json({ status: "approved" }));
    };
    const local = createClientStore({
      snapshot: signedIn("u1"),
      server: false,
      fetch,
    });
    const onServer = createClientStore({
      snapshot: signedIn("u1"),
      approvals: "/api/approvals",
      fetch,
    });
    local.subscribe(() => undefined);
    onServer.subscribe(() => undefined);
    local.approvalState(required);
    onServer.approvalState(required);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toBe(0);
  });

  it("marks a request pending once it is sent", async () => {
    const store = createClientStore({
      snapshot: signedIn("u1"),
      approvals: "/api/approvals",
      server: false,
      fetch: () => Promise.resolve(json({ status: "pending" })),
    });
    await store.requestApproval(required, "please");
    expect(store.approvalState(required)).toBe("pending");
    expect(
      store.approvalState({
        outcome: "denied",
        denials: [],
        alternatives: [],
      }),
    ).toBe("not-needed");
  });
});

describe("createClientStore snapshot sources", () => {
  it("stays pending until a followed promise settles", async () => {
    const store = createClientStore({
      snapshot: emptySnapshot(),
      server: false,
    });
    let resolve: (value: Snapshot) => void = ignore;
    store.follow(
      new Promise<Snapshot>((fulfil) => {
        resolve = fulfil;
      }),
    );
    expect(store.get().status()).toBe("pending");
    resolve(signedIn("u1"));
    await Promise.resolve();
    await Promise.resolve();
    expect(store.get().status()).toBe("ready");
    expect(store.get().subject.principal?.id).toBe("u1");
  });

  it("drops a followed promise that settles after a replace", async () => {
    const store = createClientStore({
      snapshot: emptySnapshot(),
      server: false,
    });
    let resolve: (value: Snapshot) => void = ignore;
    store.follow(
      new Promise<Snapshot>((fulfil) => {
        resolve = fulfil;
      }),
    );
    store.replace(signedIn("u2"));
    resolve(signedIn("u1"));
    await Promise.resolve();
    await Promise.resolve();
    expect(store.get().subject.principal?.id).toBe("u2");
    expect(store.get().status()).toBe("ready");
  });

  it("fails closed when a followed promise rejects", async () => {
    const store = createClientStore({
      snapshot: signedIn("u1"),
      server: false,
    });
    store.follow(Promise.reject(new Error("offline")));
    await Promise.resolve();
    await Promise.resolve();
    expect(store.get().subject.principal).toBeNull();
    expect(store.get().status()).toBe("server-only");
  });

  it("verifies a signed snapshot passed to replace", async () => {
    const verifier: TokenVerifier = {
      verify: (token) =>
        Promise.resolve(
          token === "a.b.c"
            ? {
                ok: true,
                claims: { snapshot: signedIn("u3") },
                header: { alg: "ES256" },
              }
            : { ok: false, reason: "invalid-token", cause: "malformed" },
        ),
    };
    const store = createClientStore({
      snapshot: emptySnapshot(),
      server: false,
      verifier,
    });
    store.replace("a.b.c");
    await Promise.resolve();
    await Promise.resolve();
    expect(store.get().subject.principal?.id).toBe("u3");
  });

  it("fails closed for a JWS without a verifier, a throwing verifier and garbage", async () => {
    const plain = createClientStore({ snapshot: "a.b.c", server: false });
    expect(plain.get().status()).toBe("server-only");
    const throwing = createClientStore({
      snapshot: "a.b.c",
      server: false,
      verifier: { verify: () => Promise.reject(new Error("jwks down")) },
    });
    expect(throwing.get().status()).toBe("pending");
    await settle();
    expect(throwing.get().status()).toBe("server-only");
    const garbage = createClientStore({
      snapshot: signedIn("u1"),
      server: false,
    });
    garbage.replace({ v: 99 });
    expect(garbage.get().subject.principal).toBeNull();
    expect(garbage.get().status()).toBe("server-only");
  });

  it("drops a verification that finishes after a newer snapshot", async () => {
    let finish: () => void = ignore;
    const verifier: TokenVerifier = {
      verify: () =>
        new Promise((resolve) => {
          finish = () => {
            resolve({
              ok: true,
              claims: { snapshot: signedIn("old") },
              header: { alg: "ES256" },
            });
          };
        }),
    };
    const store = createClientStore({
      snapshot: "a.b.c",
      server: false,
      verifier,
    });
    store.replace(signedIn("new"));
    finish();
    await settle();
    expect(store.get().subject.principal?.id).toBe("new");
  });

  it("follows a promise that resolves to a JWS and keeps portable checks pending meanwhile", async () => {
    const snapshot = await memberSnapshot();
    const verifier: TokenVerifier = {
      verify: () =>
        Promise.resolve({
          ok: true,
          claims: { snapshot },
          header: { alg: "ES256" },
        }),
    };
    const store = createClientStore({
      snapshot: emptySnapshot(),
      server: false,
      verifier,
    });
    let resolve: (value: string) => void = ignore;
    store.follow(
      new Promise<string>((done) => {
        resolve = done;
      }),
    );
    expect(store.permissionState(permissions.post.read, ownPost).status).toBe(
      "pending",
    );
    resolve("a.b.c");
    await settle();
    expect(store.permissionState(permissions.post.read, ownPost)).toMatchObject(
      { allowed: true, status: "ready" },
    );
  });

  it("exposes the latest snapshot and the current client", async () => {
    const snapshot = await memberSnapshot();
    const store = createClientStore({ snapshot, server: false });
    expect(store.snapshot()).toEqual(snapshot);
    const first = store.get();
    store.replace(signedIn("u2"));
    // SAFETY: the store defines this symbol as a function returning the latest client.
    const current = (first as unknown as Record<symbol, () => unknown>)[
      Symbol.for("permdock.current")
    ];
    expect(current?.()).toBe(store.get());
  });
});

async function settle(): Promise<void> {
  for (let tick = 0; tick < 10; tick += 1) {
    await Promise.resolve();
  }
}

async function memberSnapshot(): Promise<Snapshot> {
  // SAFETY: memberUser is the quick-start policy's own user fixture; only the generic is erased.
  const server = await createPermDock(policy as never, memberUser);
  const snapshot = server.snapshot();
  if (snapshot instanceof Promise) {
    throw new Error("expected JSON snapshot");
  }
  return snapshot;
}

/** The member snapshot with `post.update` marked server-only, so checks go to the endpoint. */
async function closureSnapshot(
  extra: Partial<Snapshot> = {},
): Promise<Snapshot> {
  const snapshot = await memberSnapshot();
  return {
    ...snapshot,
    ...extra,
    grants: snapshot.grants.map((grant) =>
      grant.permission === "post.update"
        ? {
            permission: grant.permission,
            effect: grant.effect,
            role: grant.role,
            to: grant.to,
            portable: false as const,
          }
        : grant,
    ),
  };
}

const granted = {
  outcome: "granted",
  subject: { principal: { id: "u1", roles: ["member"] }, context: {} },
  matched: { role: "member", permission: "post.update" },
  token: "pd1.x",
};

describe("createClientStore endpoint evaluations", () => {
  it("batches checks of one tick into one request and caches per row id", async () => {
    const bodies: unknown[] = [];
    const store = createClientStore({
      snapshot: await closureSnapshot(),
      endpoint: "/api/permdock",
      headers: { "x-test": "1" },
      server: false,
      fetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return json({
          evaluations: [
            { context: { permdock: granted } },
            {},
            { context: { permdock: granted } },
          ],
        });
      },
    });
    expect(store.permissionState(permissions.post.update, ownPost).status).toBe(
      "pending",
    );
    store.permissionState(permissions.post.update, { ...ownPost, id: 7 });
    store.permissionState(permissions.post.update);
    expect(store.get().status()).toBe("pending");
    await settle();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({
      evaluations: [
        {
          subject: { type: "user", id: "u1" },
          action: { name: "update" },
          resource: { type: "post", id: "p1" },
        },
        { resource: { id: "7" } },
        { resource: { type: "post" } },
      ],
    });
    expect(
      store.permissionState(permissions.post.update, ownPost).allowed,
    ).toBe(true);
    const missing = store.permissionState(permissions.post.update, {
      ...ownPost,
      id: 7,
    });
    expect(missing.allowed).toBe(false);
    expect(store.get().status()).toBe("ready");
  });

  it("denies server-only when the endpoint fails or the snapshot is simulated", async () => {
    let calls = 0;
    const failing = createClientStore({
      snapshot: await closureSnapshot(),
      endpoint: "/api/permdock",
      server: false,
      fetch: async () => {
        calls += 1;
        return json({}, 500);
      },
    });
    failing.permissionState(permissions.post.update, ownPost);
    await settle();
    expect(
      failing.permissionState(permissions.post.update, ownPost),
    ).toMatchObject({ allowed: false, status: "server-only" });
    const simulated = createClientStore({
      snapshot: await closureSnapshot({ simulated: true }),
      endpoint: "/api/permdock",
      server: false,
      fetch: async () => {
        calls += 1;
        return json({});
      },
    });
    simulated.permissionState(permissions.post.update, ownPost);
    await settle();
    expect(
      simulated.permissionState(permissions.post.update, ownPost).status,
    ).toBe("server-only");
    expect(calls).toBe(1);
  });

  it("drops answers that arrive after the snapshot changed", async () => {
    const snapshot = await closureSnapshot();
    let answer: (response: Response) => void = ignore;
    let reject: (error: Error) => void = ignore;
    const store = createClientStore({
      snapshot,
      endpoint: "/api/permdock",
      server: false,
      fetch: () =>
        new Promise<Response>((resolve, fail) => {
          answer = resolve;
          reject = fail;
        }),
    });
    store.permissionState(permissions.post.update, ownPost);
    await settle();
    store.replace(snapshot);
    answer(json({ evaluations: [{ context: { permdock: granted } }] }));
    await settle();
    const after = store.permissionState(permissions.post.update, ownPost);
    expect(after.allowed).toBe(false);
    await settle();
    store.replace(snapshot);
    reject(new Error("offline"));
    await settle();
    expect(store.permissionState(permissions.post.update, ownPost).status).toBe(
      "pending",
    );
  });

  it("reuses a local decision only within one render pass", async () => {
    const store = createClientStore({
      snapshot: await memberSnapshot(),
      server: false,
      passCache: true,
    });
    const first = store.permissionState(permissions.post.read, ownPost);
    expect(store.permissionState(permissions.post.read, ownPost).decision).toBe(
      first.decision,
    );
    await settle();
    expect(
      store.permissionState(permissions.post.read, ownPost).decision,
    ).not.toBe(first.decision);
  });

  it("evaluates every check without passCache, so an in-place edit is read at once", async () => {
    const store = createClientStore({
      snapshot: await memberSnapshot(),
      server: false,
    });
    const row = { ...ownPost };
    const first = store.permissionState(permissions.post.update, row);
    expect(first.allowed).toBe(true);
    expect(
      store.permissionState(permissions.post.update, row).decision,
    ).not.toBe(first.decision);
    row.authorId = "someone-else";
    expect(store.permissionState(permissions.post.update, row).allowed).toBe(
      false,
    );
  });

  it("denies without throwing when reading the row throws", async () => {
    const store = createClientStore({
      snapshot: await memberSnapshot(),
      server: false,
    });
    const hostile = new Proxy(
      {},
      {
        get(): never {
          throw new Error("boom");
        },
      },
    );
    const state = store.permissionState(permissions.post.update, hostile);
    expect(state.allowed).toBe(false);
    expect(state.decision.outcome).toBe("denied");
  });

  it("reports a persisted start stale until a replace lands", async () => {
    const snapshot = await memberSnapshot();
    const store = createClientStore({ snapshot, server: false, stale: true });
    expect(store.get().status()).toBe("stale");
    expect(store.permissionState(permissions.post.read, ownPost).status).toBe(
      "stale",
    );
    store.replace(snapshot);
    expect(store.get().status()).toBe("ready");
  });

  it("reads a headers getter on every request", async () => {
    let token = "one";
    const seen: (string | null)[] = [];
    const store = createClientStore({
      snapshot: await memberSnapshot(),
      snapshotUrl: "/api/snapshot",
      server: false,
      headers: () => ({ authorization: `Bearer ${token}` }),
      fetch: (_input, init) => {
        seen.push(new Headers(init?.headers).get("authorization"));
        return Promise.resolve(json({}, 500));
      },
    });
    await store.get().refresh();
    token = "two";
    await store.get().refresh();
    expect(seen).toEqual(["Bearer one", "Bearer two"]);
  });

  it("stops persisting and refreshing after dispose", async () => {
    const persisted: unknown[] = [];
    let calls = 0;
    const store = createClientStore({
      snapshot: await memberSnapshot(),
      snapshotUrl: "/api/snapshot",
      server: false,
      onSnapshot: (next) => {
        persisted.push(next);
      },
      fetch: () => {
        calls += 1;
        return Promise.resolve(json({}, 500));
      },
    });
    const before = persisted.length;
    store.dispose();
    await store.get().refresh();
    store.replace(signedIn("u2"));
    expect(calls).toBe(0);
    expect(persisted).toHaveLength(before);
    expect(store.get().subject.principal?.id).toBe("u2");
  });

  it("keys rows without an id by their content", async () => {
    const bodies: { evaluations: unknown[] }[] = [];
    const store = createClientStore({
      snapshot: await closureSnapshot(),
      endpoint: "/api/permdock",
      server: false,
      fetch: async (_input, init) => {
        const body = JSON.parse(String(init?.body));
        bodies.push(body);
        return json({
          evaluations: body.evaluations.map(() => ({
            context: { permdock: granted },
          })),
        });
      },
    });
    const draft = { authorId: "u1", title: "a" };
    store.permissionState(permissions.post.update, draft);
    store.permissionState(permissions.post.update, { ...draft, title: "b" });
    store.permissionState(permissions.post.update, {
      title: "a",
      authorId: "u1",
    });
    await settle();
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.evaluations).toHaveLength(2);
  });

  it("reads the row id from the field the snapshot names", async () => {
    const bodies: unknown[] = [];
    const store = createClientStore({
      snapshot: await closureSnapshot({ ids: { post: "slug" } }),
      endpoint: "/api/permdock",
      server: false,
      fetch: async (_input, init) => {
        bodies.push(JSON.parse(String(init?.body)));
        return json({ evaluations: [{ context: { permdock: granted } }, {}] });
      },
    });
    store.permissionState(permissions.post.update, { ...ownPost, slug: "s1" });
    store.permissionState(permissions.post.update, { ...ownPost, slug: "s2" });
    await settle();
    expect(bodies[0]).toMatchObject({
      evaluations: [{ resource: { id: "s1" } }, { resource: { id: "s2" } }],
    });
    expect(
      store.permissionState(permissions.post.update, { ...ownPost, slug: "s2" })
        .allowed,
    ).toBe(false);
  });

  it("skips the request when a reset empties the queue first", async () => {
    const snapshot = await closureSnapshot();
    let calls = 0;
    const store = createClientStore({
      snapshot,
      endpoint: "/api/permdock",
      server: false,
      fetch: async () => {
        calls += 1;
        return json({});
      },
    });
    store.permissionState(permissions.post.update, ownPost);
    store.replace(snapshot);
    await settle();
    expect(calls).toBe(0);
  });
});

describe("createClientStore invalidate and refresh", () => {
  it("invalidates answers by permission, by resource node and entirely", async () => {
    const store = createClientStore({
      snapshot: await closureSnapshot(),
      endpoint: "/api/permdock",
      server: false,
      fetch: async () =>
        json({ evaluations: [{ context: { permdock: granted } }] }),
    });
    const ask = (): boolean =>
      store.permissionState(permissions.post.update, ownPost).allowed;
    ask();
    await settle();
    expect(ask()).toBe(true);
    store.get().invalidate(permissions.post.read);
    expect(ask()).toBe(true);
    expect(store.get().status()).toBe("stale");
    store.get().invalidate(permissions.post.update);
    expect(ask()).toBe(false);
    await settle();
    expect(ask()).toBe(true);
    store.get().invalidate({ key: "post" });
    expect(ask()).toBe(false);
    await settle();
    store.get().invalidate({});
    expect(ask()).toBe(false);
  });

  it("adds the tenant to a snapshot URL with a query string and a hash", async () => {
    const urls: string[] = [];
    const store = createClientStore({
      snapshot: signedIn("u1"),
      snapshotUrl: "/api/snapshot?v=1#top",
      server: false,
      fetch: async (input) => {
        urls.push(String(input));
        return json(signedIn("u1"));
      },
    });
    await store.get().refresh({ tenant: "globex" });
    expect(urls).toEqual(["/api/snapshot?v=1&tenant=globex#top"]);
    expect(store.get().status()).toBe("ready");
  });

  it("switches tenants locally and does nothing without a source", async () => {
    const store = createClientStore({
      snapshot: signedIn("u1"),
      server: false,
    });
    await store.get().refresh();
    expect(store.get().status()).toBe("ready");
    await store.get().refresh({ tenant: "acme" });
    expect(store.get().status()).toBe("ready");
  });

  it("marks the snapshot stale when a refresh fails in any way", async () => {
    const answers: (() => Promise<Response>)[] = [
      () => Promise.reject(new Error("offline")),
      async () => json({ v: 99 }),
      async () => json("a.b.c"),
    ];
    const store = createClientStore({
      snapshot: signedIn("u1"),
      snapshotUrl: "/api/snapshot",
      server: false,
      fetch: () => answers.shift()?.() ?? Promise.resolve(json({}, 500)),
    });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await store.get().refresh();
      expect({ attempt, status: store.get().status() }).toEqual({
        attempt,
        status: "stale",
      });
    }
    expect(store.get().subject.principal?.id).toBe("u1");
  });

  it("verifies a signed snapshot returned by refresh", async () => {
    const store = createClientStore({
      snapshot: signedIn("u1"),
      snapshotUrl: "/api/snapshot",
      server: false,
      verifier: {
        verify: async () => ({
          ok: true,
          claims: { snapshot: signedIn("u5") },
          header: { alg: "ES256" },
        }),
      },
      fetch: async () => json("a.b.c"),
    });
    await store.get().refresh();
    expect(store.get().subject.principal?.id).toBe("u5");
  });

  it("keeps only the latest of two overlapping refreshes", async () => {
    const pending: ((response: Response) => void)[] = [];
    const store = createClientStore({
      snapshot: signedIn("u1"),
      snapshotUrl: "/api/snapshot",
      server: false,
      fetch: () =>
        new Promise<Response>((resolve) => {
          pending.push(resolve);
        }),
    });
    const first = store.get().refresh();
    const second = store.get().refresh();
    pending[1]?.(json(signedIn("second")));
    await second;
    pending[0]?.(json(signedIn("first")));
    await first;
    expect(store.get().subject.principal?.id).toBe("second");
  });

  it("reports stale past maxAge and expiresAt", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(10_000_000);
      const now = Math.floor(Date.now() / 1000);
      const aged = createClientStore({
        snapshot: { ...signedIn("u1"), issuedAt: now - 120 },
        maxAge: 60,
        server: false,
      });
      expect(aged.get().status()).toBe("stale");
      const fresh = createClientStore({
        snapshot: { ...signedIn("u1"), issuedAt: now - 10 },
        maxAge: 60,
        server: false,
      });
      expect(fresh.get().status()).toBe("ready");
      const expired = createClientStore({
        snapshot: { ...signedIn("u1"), expiresAt: now - 1 },
        server: false,
      });
      expect(expired.get().status()).toBe("stale");
      expect(
        expired.permissionState(permissions.post.read, ownPost).status,
      ).toBe("stale");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("createClientStore approval edge cases", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("expires on 404, ignores unknown statuses and network errors", async () => {
    const answers: (() => Promise<Response>)[] = [
      () => Promise.reject(new Error("offline")),
      async () => json({ status: "weird" }),
      async () => json({}, 500),
      async () => json({}, 404),
    ];
    const store = createClientStore({
      snapshot: signedIn("u1"),
      approvals: "/api/approvals/",
      server: false,
      approvalInterval: 100,
      fetch: () => answers.shift()?.() ?? Promise.resolve(json({}, 500)),
    });
    const stop = store.subscribe(ignore);
    store.approvalState(required);
    // Each failure doubles the wait: 100, then 200, 400 and 800 ms.
    await vi.advanceTimersByTimeAsync(700);
    expect(store.approvalState(required)).toBe("required");
    await vi.advanceTimersByTimeAsync(800);
    expect(store.approvalState(required)).toBe("expired");
    stop();
  });

  it("stops polling after a refusal or repeated failures", async () => {
    let refusedCalls = 0;
    const refused = createClientStore({
      snapshot: signedIn("u1"),
      approvals: "/api/approvals",
      server: false,
      approvalInterval: 100,
      fetch: async () => {
        refusedCalls += 1;
        return json({}, 403);
      },
    });
    let failedCalls = 0;
    const failing = createClientStore({
      snapshot: signedIn("u1"),
      approvals: "/api/approvals",
      server: false,
      approvalInterval: 100,
      fetch: async () => {
        failedCalls += 1;
        return json({}, 503);
      },
    });
    const stops = [refused.subscribe(ignore), failing.subscribe(ignore)];
    refused.approvalState(required);
    failing.approvalState(required);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(refusedCalls).toBe(1);
    expect(failedCalls).toBe(5);
    expect(failing.approvalState(required)).toBe("required");
    for (const stop of stops) {
      stop();
    }
  });

  it("forgets approval state when another user's snapshot replaces the store's", async () => {
    let calls = 0;
    const store = createClientStore({
      snapshot: signedIn("u1"),
      approvals: "/api/approvals",
      server: false,
      approvalInterval: 100,
      fetch: async () => {
        calls += 1;
        return json({ status: "approved" });
      },
    });
    const stop = store.subscribe(ignore);
    store.approvalState(required);
    await vi.advanceTimersByTimeAsync(100);
    expect(store.approvalState(required)).toBe("approved");
    store.replace(signedIn("u2"));
    expect(store.approvalState(required)).toBe("required");
    store.replace(signedIn("u2"));
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toBe(2);
    stop();
  });

  it("polls again when a subscriber returns", async () => {
    let calls = 0;
    const store = createClientStore({
      snapshot: signedIn("u1"),
      approvals: "/api/approvals",
      server: false,
      approvalInterval: 100,
      fetch: async () => {
        calls += 1;
        return json({ status: "approved" });
      },
    });
    store.subscribe(ignore)();
    store.approvalState(required);
    const first = store.subscribe(ignore);
    store.approvalState(required);
    first();
    const second = store.subscribe(ignore);
    await vi.advanceTimersByTimeAsync(100);
    expect(calls).toBe(1);
    expect(store.approvalState(required)).toBe("approved");
    second();
  });

  it("drops a poll answer that lands after clear", async () => {
    let answer: (response: Response) => void = ignore;
    const store = createClientStore({
      snapshot: signedIn("u1"),
      approvals: "/api/approvals",
      server: false,
      approvalInterval: 100,
      fetch: () =>
        new Promise<Response>((resolve) => {
          answer = resolve;
        }),
    });
    const stop = store.subscribe(ignore);
    store.approvalState(required);
    await vi.advanceTimersByTimeAsync(100);
    store.get().clear();
    answer(json({ status: "approved" }));
    await vi.advanceTimersByTimeAsync(0);
    expect(store.approvalState(required)).toBe("required");
    stop();
  });

  it("sends a request only for approval-required decisions with a target", async () => {
    const posts: unknown[] = [];
    const fetch = async (
      input: string | URL | Request,
      init?: RequestInit,
    ): Promise<Response> => {
      posts.push([String(input), JSON.parse(String(init?.body))]);
      return json({ status: "pending" });
    };
    const viaEndpoint = createClientStore({
      snapshot: signedIn("u1"),
      endpoint: "/api/permdock",
      server: false,
      fetch,
    });
    await viaEndpoint.requestApproval(required, "note");
    expect(posts).toEqual([
      [
        "/api/permdock",
        { permission: "post.publish", token: "pd1.token/one", note: "note" },
      ],
    ]);
    await viaEndpoint.requestApproval({
      outcome: "denied",
      denials: [],
      alternatives: [],
    });
    await createClientStore({
      snapshot: signedIn("u1"),
      server: false,
      fetch,
    }).requestApproval(required);
    await createClientStore({
      snapshot: { ...signedIn("u1"), simulated: true },
      approvals: "/api/approvals",
      server: false,
      fetch,
    }).requestApproval(required);
    expect(posts).toHaveLength(1);
  });

  it("keeps a terminal approval state when a request is sent again", async () => {
    const store = createClientStore({
      snapshot: signedIn("u1"),
      approvals: "/api/approvals",
      server: false,
      approvalInterval: 100,
      fetch: async () => json({ status: "rejected" }),
    });
    const stop = store.subscribe(ignore);
    store.approvalState(required);
    await vi.advanceTimersByTimeAsync(100);
    expect(store.approvalState(required)).toBe("rejected");
    await store.requestApproval(required);
    expect(store.approvalState(required)).toBe("rejected");
    stop();
  });
});
