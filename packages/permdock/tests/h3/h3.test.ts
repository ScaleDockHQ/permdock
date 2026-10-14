import { H3 } from "h3";
import { describe, expect, it } from "vitest";

import { defineOperations } from "../../src/core/operations.ts";
import { createPermDock } from "../../src/h3/index.ts";
import { webBotAuthVerifier } from "../../src/server/web-bot-auth.ts";
import {
  memberUser,
  otherPost,
  ownPost,
  permissions,
  policy,
} from "../fixtures/quick-start.ts";

const operations = defineOperations(permissions, {
  updatePost: {
    permission: permissions.post.update,
    data: (input: { readonly id: string }) =>
      input.id === ownPost.id ? ownPost : otherPost,
  },
});

describe("permdock/h3", () => {
  it("sets event.context.permdock and protects routes with route middleware", async () => {
    const { middleware, protect, withPermDock } = createPermDock(policy, {
      subject: () => memberUser,
    });
    const app = new H3();
    app.use(middleware());
    app.delete(
      "/posts/:id",
      withPermDock<typeof ownPost>((event) =>
        Response.json({
          id: event.context.permdockData.id,
          via: event.context.permdock.subject.principal?.id,
        }),
      ),
      {
        middleware: [
          protect(permissions.post.update, (event) =>
            event.context.params?.["id"] === "p1" ? ownPost : otherPost,
          ),
        ],
      },
    );

    const allowed = await app.request("/posts/p1", { method: "DELETE" });
    const denied = await app.request("/posts/p2", { method: "DELETE" });
    expect(await allowed.json()).toEqual({ id: "p1", via: "u1" });
    expect(denied.status).toBe(403);
    expect(denied.headers.get("content-type")).toContain(
      "application/problem+json",
    );
  });

  it("protects with an operation and its input reader", async () => {
    const { protect } = createPermDock(policy, { subject: () => memberUser });
    const app = new H3();
    app.put("/posts/:id", () => "ok", {
      middleware: [
        protect(operations.updatePost, (event) => ({
          id: event.context.params?.["id"] ?? "",
        })),
      ],
    });
    const own = await app.request("/posts/p1", { method: "PUT" });
    const other = await app.request("/posts/p2", { method: "PUT" });
    expect([own.status, other.status]).toEqual([200, 403]);
  });

  it("maps a downstream denial in middleware and in withPermDock", async () => {
    const { middleware, withPermDock } = createPermDock(policy, {
      subject: () => memberUser,
    });
    const app = new H3();
    app.use(middleware());
    app.get("/denied", (event) => {
      // SAFETY: middleware() set event.context.permdock for every request.
      const instance = event.context["permdock"] as {
        assert: (p: unknown, row: unknown) => void;
      };
      instance.assert(permissions.post.update, otherPost);
      return "ok";
    });
    const bare = new H3();
    bare.get(
      "/denied",
      withPermDock((event) => {
        event.context.permdock.assert(permissions.post.update, otherPost);
        return "ok";
      }),
    );
    const viaMiddleware = await app.request("/denied");
    const viaWrapper = await bare.request("/denied");
    expect([viaMiddleware.status, viaWrapper.status]).toEqual([403, 403]);
  });

  it("answers a bad Web Bot Auth signature in middleware and withPermDock", async () => {
    const { middleware, withPermDock } = createPermDock(policy, {
      subject: () => memberUser,
      webBotAuth: webBotAuthVerifier({
        verify: true,
        keys: { lookup: () => undefined },
      }),
    });
    const headers = {
      "Signature-Input":
        'sig1=("@method");created=1700000000;keyid="bot-1";alg="ed25519"',
      Signature: "sig1=:AAAA:",
      "Signature-Agent": '"https://agents.example.com"',
    };
    const app = new H3();
    app.use(middleware());
    app.get("/", () => "reached");
    const bare = new H3();
    bare.get(
      "/",
      withPermDock(() => "reached"),
    );
    const viaMiddleware = await app.request("/", { headers });
    const viaWrapper = await bare.request("/", { headers });
    expect([viaMiddleware.status, viaWrapper.status]).toEqual([403, 403]);
  });

  it("mounts the decision endpoint and builds snapshots and instances", async () => {
    const { permdockHandler, getSnapshot, getPermDock } = createPermDock(
      policy,
      { subject: () => memberUser },
    );
    const app = new H3();
    app.all("/api/permdock", permdockHandler());
    app.get("/snapshot", async (event) => getSnapshot(event));
    app.get("/who", async (event) => {
      const instance = await getPermDock(event);
      return instance.subject.principal?.id ?? "none";
    });
    const endpoint = await app.request("/api/permdock");
    const snapshot = await app.request("/snapshot");
    const who = await app.request("/who");
    expect(endpoint.status).toBe(200);
    expect(await snapshot.json()).toMatchObject({ v: 1 });
    expect(await who.text()).toBe("u1");
  });
});
