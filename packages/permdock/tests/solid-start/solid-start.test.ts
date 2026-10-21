import type { APIEvent } from "@solidjs/start/server";
import type { H3Event } from "h3";

import { H3 } from "h3";
import { describe, expect, it } from "vitest";

import { webBotAuthVerifier } from "../../src/server/web-bot-auth.ts";
import { createPermDock } from "../../src/solid-start/index.ts";
import {
  memberUser,
  otherPost,
  ownPost,
  permissions,
  policy,
} from "../fixtures/quick-start.ts";

/** The `APIEvent` SolidStart builds from the h3 event of an API route. */
function apiEvent(event: H3Event): APIEvent {
  // SAFETY: the adapter reads only request, locals, params and nativeEvent.
  return {
    request: event.req,
    nativeEvent: event,
    locals: {},
    params: event.context.params ?? {},
  } as never;
}

function serve(handler: (event: APIEvent) => unknown): H3 {
  return new H3().all("/**", (event) => handler(apiEvent(event)));
}

const badSignature = {
  "Signature-Input":
    'sig1=("@method");created=1700000000;keyid="bot-1";alg="ed25519"',
  Signature: "sig1=:AAAA:",
  "Signature-Agent": '"https://agents.example.com"',
};

describe("permdock/solid-start", () => {
  it("sets the instance in h3 middleware and reuses it in withPermDock", async () => {
    const { middleware, withPermDock } = createPermDock(policy, {
      subject: () => memberUser,
    });
    const seen: unknown[] = [];
    const app = new H3();
    app.use(middleware());
    app.get("/", (event) =>
      withPermDock((api) => {
        seen.push(event.context["permdock"], api.locals.permdock);
        return new Response(api.locals.permdock.subject.principal?.id);
      })(apiEvent(event)),
    );
    const response = await app.request("/");
    expect(await response.text()).toBe("u1");
    expect(seen[0]).toBe(seen[1]);
  });

  it("protects an API route with the row on locals", async () => {
    const { protect } = createPermDock(policy, { subject: () => memberUser });
    const DELETE = protect(permissions.post.update, (event) =>
      event.params["id"] === "p1" ? ownPost : otherPost,
    )((event) => Response.json({ id: event.locals.permdockData.id }));
    const app = new H3().delete("/posts/:id", (event) =>
      DELETE(apiEvent(event)),
    );
    const own = await app.request("/posts/p1", { method: "DELETE" });
    const other = await app.request("/posts/p2", { method: "DELETE" });
    expect(await own.json()).toStrictEqual({ id: "p1" });
    expect(other.status).toBe(403);
  });

  it("maps a denial thrown in a route and answers a bad signature", async () => {
    const { middleware, withPermDock } = createPermDock(policy, {
      subject: () => memberUser,
      webBotAuth: webBotAuthVerifier({
        verify: true,
        keys: { lookup: () => undefined },
      }),
    });
    const denied = serve(
      withPermDock((event) => {
        event.locals.permdock.assert(permissions.post.update, otherPost);
        return new Response("ok");
      }),
    );
    const guarded = new H3().use(middleware()).get("/", () => "reached");
    const assertion = await denied.request("/");
    const signedWrapper = await denied.request("/", { headers: badSignature });
    const signedMiddleware = await guarded.request("/", {
      headers: badSignature,
    });
    expect([
      assertion.status,
      signedWrapper.status,
      signedMiddleware.status,
    ]).toStrictEqual([403, 403, 403]);
  });

  it("maps a denial thrown below the h3 middleware", async () => {
    const { middleware } = createPermDock(policy, {
      subject: () => memberUser,
    });
    const app = new H3().use(middleware()).get("/", (event) => {
      // SAFETY: middleware() set event.context.permdock for every request.
      const instance = event.context["permdock"] as {
        assert: (p: unknown, row: unknown) => void;
      };
      instance.assert(permissions.post.update, otherPost);
      return "ok";
    });
    expect((await app.request("/")).status).toBe(403);
  });

  it("serves the decision endpoint, snapshots, instances and connections", async () => {
    const { permdockHandler, getSnapshot, getPermDock, connection } =
      createPermDock(policy, { subject: () => memberUser });
    const { GET, POST } = permdockHandler();
    const get = await serve(GET).request("/api/permdock");
    const post = await serve(POST).request("/api/permdock", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ evaluations: [] }),
    });
    const details = await serve(async (event) => {
      const snapshot = await getSnapshot(event);
      const instance = await getPermDock(event);
      const conn = await connection(event);
      return Response.json({
        v: snapshot.v,
        id: instance.subject.principal?.id,
        aborted: conn.signal.aborted,
      });
    }).request("/");
    expect([get.status, post.status]).toStrictEqual([200, 200]);
    expect(await details.json()).toStrictEqual({
      v: 1,
      id: "u1",
      aborted: false,
    });
  });
});
