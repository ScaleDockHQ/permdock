import type { APIContext } from "astro";

import { describe, expect, it } from "vitest";

import { createPermDock } from "../../src/astro/index.ts";
import { webBotAuthVerifier } from "../../src/server/web-bot-auth.ts";
import {
  memberUser,
  otherPost,
  ownPost,
  permissions,
  policy,
} from "../fixtures/quick-start.ts";

function contextFor(
  path: string,
  init?: RequestInit,
  params: Record<string, string> = {},
): APIContext {
  const request = new Request(`http://localhost${path}`, init);
  // SAFETY: the adapter reads only request, locals and the params the loaders below use.
  return { request, url: new URL(request.url), params, locals: {} } as never;
}

describe("permdock/astro", () => {
  it("sets context.locals.permdock in onRequest and calls next", async () => {
    const { middleware } = createPermDock(policy, {
      subject: () => memberUser,
    });
    const context = contextFor("/");
    const response = await middleware()(
      context,
      async () => new Response("ok"),
    );
    // SAFETY: onRequest set locals.permdock before next ran.
    const locals = context.locals as {
      readonly permdock: {
        readonly subject: { readonly principal?: { readonly id: string } };
      };
    };
    expect(response).toBeInstanceOf(Response);
    expect(locals.permdock.subject.principal?.id).toBe("u1");
  });

  it("answers a bad Web Bot Auth signature in onRequest", async () => {
    const { middleware } = createPermDock(policy, {
      subject: () => memberUser,
      webBotAuth: webBotAuthVerifier({
        verify: true,
        keys: { lookup: () => undefined },
      }),
    });
    const context = contextFor("/", {
      headers: {
        "Signature-Input":
          'sig1=("@method");created=1700000000;keyid="bot-1";alg="ed25519"',
        Signature: "sig1=:AAAA:",
        "Signature-Agent": '"https://agents.example.com"',
      },
    });
    let reached = false;
    const response = await middleware()(context, async () => {
      reached = true;
      return new Response("ok");
    });
    expect({ reached, status: response?.status }).toEqual({
      reached: false,
      status: 403,
    });
  });

  it("protects an endpoint and types the row on locals", async () => {
    const { protect } = createPermDock(policy, { subject: () => memberUser });
    const DELETE = protect(permissions.post.update, (context) =>
      context.params["id"] === "p1" ? ownPost : otherPost,
    )((context) => Response.json({ id: context.locals.permdockData.id }));
    const own = await DELETE(contextFor("/posts/p1", undefined, { id: "p1" }));
    const other = await DELETE(
      contextFor("/posts/p2", undefined, { id: "p2" }),
    );
    expect(await own.json()).toEqual({ id: "p1" });
    expect(other.status).toBe(403);
  });

  it("maps a denial thrown inside withPermDock", async () => {
    const { withPermDock } = createPermDock(policy, {
      subject: () => memberUser,
    });
    const GET = withPermDock((context) => {
      context.locals.permdock.assert(permissions.post.update, otherPost);
      return new Response("ok");
    });
    expect((await GET(contextFor("/"))).status).toBe(403);
  });

  it("serves the decision endpoint, snapshots, instances and connections", async () => {
    const { permdockHandler, getSnapshot, getPermDock, connection } =
      createPermDock(policy, { subject: () => memberUser });
    const { GET, POST } = permdockHandler();
    const snapshot = await GET(contextFor("/api/permdock"));
    const evaluations = await POST(
      contextFor("/api/permdock", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ evaluations: [] }),
      }),
    );
    const loaded = await getSnapshot(contextFor("/"));
    const instance = await getPermDock(contextFor("/"));
    const conn = await connection(contextFor("/"));
    expect([snapshot.status, evaluations.status]).toEqual([200, 200]);
    expect(loaded.v).toBe(1);
    expect(instance.can(permissions.post.read, ownPost)).toBe(true);
    expect(conn.signal.aborted).toBe(false);
  });
});
