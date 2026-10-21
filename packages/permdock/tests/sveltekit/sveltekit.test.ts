import type { RequestEvent } from "@sveltejs/kit";

import { describe, expect, it } from "vitest";

import { webBotAuthVerifier } from "../../src/server/web-bot-auth.ts";
import { createPermDock } from "../../src/sveltekit/index.ts";
import {
  memberUser,
  otherPost,
  ownPost,
  permissions,
  policy,
} from "../fixtures/quick-start.ts";

function eventFor(
  path: string,
  init?: RequestInit,
  params: Record<string, string> = {},
): RequestEvent {
  const request = new Request(`http://localhost${path}`, init);
  // SAFETY: the adapter reads only request, locals and the params the loaders below use.
  return { request, url: new URL(request.url), params, locals: {} } as never;
}

describe("permdock/sveltekit", () => {
  it("sets event.locals.permdock in the handle hook and resolves", async () => {
    const { middleware } = createPermDock(policy, {
      subject: () => memberUser,
    });
    const event = eventFor("/");
    const response = await middleware()({
      event,
      resolve: async (resolved) =>
        new Response(
          // SAFETY: the handle hook set locals.permdock before resolve.
          (
            resolved.locals as {
              permdock: { subject: { principal: { id: string } } };
            }
          ).permdock.subject.principal.id,
        ),
    });
    expect(await response.text()).toBe("u1");
  });

  it("answers a bad Web Bot Auth signature in the handle hook", async () => {
    const { middleware } = createPermDock(policy, {
      subject: () => memberUser,
      webBotAuth: webBotAuthVerifier({
        verify: true,
        keys: { lookup: () => undefined },
      }),
    });
    const event = eventFor("/", {
      headers: {
        "Signature-Input":
          'sig1=("@method");created=1700000000;keyid="bot-1";alg="ed25519"',
        Signature: "sig1=:AAAA:",
        "Signature-Agent": '"https://agents.example.com"',
      },
    });
    let resolved = false;
    const response = await middleware()({
      event,
      resolve: async () => {
        resolved = true;
        return new Response("ok");
      },
    });
    expect({ resolved, status: response.status }).toStrictEqual({
      resolved: false,
      status: 403,
    });
  });

  it("protects a +server.ts handler and types the row on locals", async () => {
    const { protect } = createPermDock(policy, { subject: () => memberUser });
    const DELETE = protect(permissions.post.update, (event) =>
      event.params["id"] === "p1" ? ownPost : otherPost,
    )((event) => Response.json({ id: event.locals.permdockData.id }));

    const own = await DELETE(eventFor("/posts/p1", undefined, { id: "p1" }));
    const other = await DELETE(eventFor("/posts/p2", undefined, { id: "p2" }));
    expect(await own.json()).toStrictEqual({ id: "p1" });
    expect(other.status).toBe(403);
  });

  it("maps a denial thrown inside withPermDock", async () => {
    const { withPermDock } = createPermDock(policy, {
      subject: () => memberUser,
    });
    const GET = withPermDock((event) => {
      event.locals.permdock.assert(permissions.post.update, otherPost);
      return new Response("ok");
    });
    expect((await GET(eventFor("/"))).status).toBe(403);
  });

  it("serves the decision endpoint and the snapshot", async () => {
    const { permdockHandler, getSnapshot, getPermDock, connection } =
      createPermDock(policy, { subject: () => memberUser });
    const { GET, POST } = permdockHandler();
    const snapshot = await GET(eventFor("/api/permdock"));
    const evaluations = await POST(
      eventFor("/api/permdock", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ evaluations: [] }),
      }),
    );
    const loaded = await getSnapshot(eventFor("/"));
    const instance = await getPermDock(eventFor("/"));
    const conn = await connection(eventFor("/"));
    expect([snapshot.status, evaluations.status]).toStrictEqual([200, 200]);
    expect(loaded.v).toBe(1);
    expect(instance.can(permissions.post.read, ownPost)).toBe(true);
    expect(conn.signal.aborted).toBe(false);
  });
});
