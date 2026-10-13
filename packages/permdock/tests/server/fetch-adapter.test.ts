import { describe, expect, it } from "vitest";

import type { PermDock } from "../../src/core/permdock.ts";

import { defineOperations } from "../../src/core/operations.ts";
import {
  fetchAdapter,
  guardedRoute,
  instanceRoute,
  protectTarget,
} from "../../src/server/fetch-adapter.ts";
import { webBotAuthVerifier } from "../../src/server/web-bot-auth.ts";
import {
  memberUser,
  otherPost,
  ownPost,
  permissions,
  policy,
} from "../fixtures/quick-start.ts";

type Event = {
  readonly request: Request;
  readonly locals: Record<string, unknown>;
};

const route = {
  context: (event: Event) => event,
  locals: (event: Event) => event.locals,
};

const operations = defineOperations(permissions, {
  updatePost: {
    permission: permissions.post.update,
    data: (input: { readonly id: string }) =>
      input.id === ownPost.id ? ownPost : otherPost,
  },
  listPosts: { permission: permissions.post.list },
});

function eventFor(path = "/", init?: RequestInit): Event {
  return { request: new Request(`http://localhost${path}`, init), locals: {} };
}

function adapterFor(
  options: Partial<Parameters<typeof fetchAdapter<Event, unknown>>[1]> = {},
) {
  return fetchAdapter(
    policy,
    { subject: () => memberUser, ...options },
    "test",
    (event: Event) => event.request,
  );
}

const unsigned = webBotAuthVerifier({
  verify: true,
  keys: { lookup: () => undefined },
});

const signedHeaders = {
  "Signature-Input":
    'sig1=("@method");created=1700000000;keyid="bot-1";alg="ed25519"',
  Signature: "sig1=:AAAA:",
  "Signature-Agent": '"https://agents.example.com"',
};

describe("guardedRoute", () => {
  it("runs the handler with the row on a grant and answers a denial with Problem Details", async () => {
    const adapter = adapterFor();
    const handler = guardedRoute(
      adapter,
      route,
      permissions.post.update,
      (event) =>
        new URL(event.request.url).pathname === "/p1" ? ownPost : otherPost,
      undefined,
    )((event) => Response.json(event.locals["permdockData"]));

    const granted = await handler(eventFor("/p1"));
    const denied = await handler(eventFor("/p2"));
    expect(await granted.json()).toEqual(ownPost);
    expect(denied.status).toBe(403);
    expect(denied.headers.get("content-type")).toContain(
      "application/problem+json",
    );
  });

  it("loads an operation's row from the input reader", async () => {
    const adapter = adapterFor();
    const guarded = guardedRoute(
      adapter,
      route,
      operations.updatePost,
      (event) => ({ id: new URL(event.request.url).pathname.slice(1) }),
      undefined,
    )(() => new Response("ok"));
    const unloaded = guardedRoute(
      adapter,
      route,
      operations.updatePost,
      undefined,
      undefined,
    )(() => new Response("ok"));

    expect((await guarded(eventFor("/p1"))).status).toBe(200);
    expect((await guarded(eventFor("/p2"))).status).toBe(403);
    expect((await unloaded(eventFor("/"))).status).toBe(403);
  });

  it("checks an operation without a loader on the permission alone", async () => {
    const adapter = adapterFor();
    const handler = guardedRoute(
      adapter,
      route,
      operations.listPosts,
      undefined,
      undefined,
    )((event) => {
      // SAFETY: guardedRoute set locals.permdock before the handler ran.
      const instance = event.locals["permdock"] as PermDock;
      return new Response(instance.subject.principal?.id);
    });
    expect(await (await handler(eventFor())).text()).toBe("u1");
  });
});

describe("instanceRoute", () => {
  it("builds the instance once and reuses one already on the locals", async () => {
    const adapter = adapterFor();
    const seen: unknown[] = [];
    const handler = instanceRoute(
      adapter,
      route,
    )((event) => {
      seen.push(event.locals["permdock"]);
      return new Response("ok");
    });
    const event = eventFor();
    await handler(event);
    await handler(event);
    expect(seen).toHaveLength(2);
    expect(seen[0]).toBe(seen[1]);
  });

  it("maps a thrown PermDock error and rethrows any other", async () => {
    const adapter = adapterFor();
    const denied = instanceRoute(
      adapter,
      route,
    )((event) => {
      // SAFETY: instanceRoute set locals.permdock before the handler ran.
      (event.locals["permdock"] as PermDock).assert(
        permissions.post.update,
        otherPost,
      );
      return new Response("ok");
    });
    const boom = instanceRoute(
      adapter,
      route,
    )(() => {
      throw new Error("boom");
    });
    expect((await denied(eventFor())).status).toBe(403);
    await expect(boom(eventFor())).rejects.toThrow("boom");
  });

  it("answers a bad Web Bot Auth signature before the handler", async () => {
    const adapter = adapterFor({ webBotAuth: unsigned });
    let reached = false;
    const handler = instanceRoute(
      adapter,
      route,
    )(() => {
      reached = true;
      return new Response("ok");
    });
    const response = await handler(eventFor("/", { headers: signedHeaders }));
    expect({ reached, status: response.status }).toEqual({
      reached: false,
      status: 403,
    });
  });
});

describe("fetchAdapter", () => {
  it("routes the decision endpoint by method and answers others with 405", async () => {
    const handler = adapterFor().handler();
    const get = await handler(eventFor("/api/permdock"));
    const head = await handler(eventFor("/api/permdock", { method: "HEAD" }));
    const post = await handler(
      eventFor("/api/permdock", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          evaluations: [
            {
              resource: { type: "post", properties: ownPost },
              action: { name: "update" },
            },
          ],
        }),
      }),
    );
    const put = await handler(eventFor("/api/permdock", { method: "PUT" }));
    // SAFETY: AuthZEN response JSON produced by the handler under test.
    const body = (await post.json()) as {
      readonly evaluations: readonly { readonly decision: boolean }[];
    };
    expect([get.status, head.status, put.status]).toEqual([200, 200, 405]);
    expect(put.headers.get("allow")).toBe("GET, HEAD, POST");
    expect(body.evaluations[0]?.decision).toBe(true);
  });

  it("builds a snapshot for the tenant the query names", async () => {
    const adapter = adapterFor();
    const own = await adapter.getSnapshot(eventFor());
    const named = await adapter.getSnapshot(eventFor(), { tenant: "o2" });
    expect(own.v).toBe(1);
    expect(named.v).toBe(1);
  });

  it("opens a connection and builds an instance per request", async () => {
    const adapter = adapterFor();
    const conn = await adapter.connection(eventFor(), {
      permission: permissions.post.list,
    });
    const instance = await adapter.getPermDock(eventFor());
    expect(conn.signal.aborted).toBe(false);
    expect(instance.can(permissions.post.read, ownPost)).toBe(true);
  });

  it("replaces a null instance left on the target", async () => {
    const adapter = adapterFor();
    const target: Record<string, unknown> = { permdock: null };
    const attached = await adapter.ensure(target, eventFor());
    expect(attached.ok).toBe(true);
    expect(target["permdock"]).not.toBeNull();
  });
});

describe("protectTarget", () => {
  it("passes a permission and null through with their loader", () => {
    const load = () => ownPost;
    expect(protectTarget(permissions.post.update, load)).toEqual({
      permission: permissions.post.update,
      data: load,
    });
    expect(protectTarget(null, undefined)).toEqual({
      permission: null,
      data: undefined,
    });
  });
});
