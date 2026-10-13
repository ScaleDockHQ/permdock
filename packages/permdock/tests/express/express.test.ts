import express from "express";
import { describe, expect, it } from "vitest";

import {
  createPermDock,
  InvalidSignatureError,
} from "../../src/express/index.ts";
import { invalidSignatureProblem } from "../../src/server/web-bot-auth.ts";
import { listen } from "../fakes/server.ts";
import {
  memberUser,
  otherPost,
  ownPost,
  permissions,
  policy,
} from "../fixtures/quick-start.ts";

describe("permdock/express", () => {
  it("sets a request-scoped instance and protects routes", async () => {
    const { middleware, protect, withPermDock } = createPermDock(policy, {
      subject: () => memberUser,
    });
    const app = express();
    app.use(middleware());
    app.delete(
      "/posts/:id",
      protect(permissions.post.update, (req) =>
        req.params["id"] === "p1" ? ownPost : otherPost,
      ),
      withPermDock((req, res) => {
        res.json({ ok: true, via: req.permdock.subject.principal?.id });
      }),
    );
    const request = await listen(app);

    const allowed = await request("/posts/p1", { method: "DELETE" });
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({ ok: true, via: "u1" });

    const denied = await request("/posts/p2", { method: "DELETE" });
    expect(denied.status).toBe(403);
    expect(denied.headers.get("content-type")).toContain(
      "application/problem+json",
    );
  });

  it("resolves the actor from the Express request", async () => {
    const { middleware, withPermDock } = createPermDock(policy, {
      subject: () => memberUser,
      actor: (req) => ({ id: req.path, kind: "agent" }),
    });
    const app = express();
    app.use(middleware());
    app.get(
      "/posts",
      withPermDock((req, res) => {
        res.json(req.permdock.subject.actor);
      }),
    );
    const request = await listen(app);
    expect(await (await request("/posts")).json()).toEqual({
      id: "/posts",
      kind: "agent",
    });
  });

  it("answers 401 with a bare Bearer challenge to a caller without credentials", async () => {
    const { protect } = createPermDock(policy, {
      subject: () => null,
    });
    const app = express();
    app.get(
      "/posts/:id",
      protect(permissions.post.read, () => ownPost),
      (_req, res) => {
        res.json({ ok: true });
      },
    );
    const request = await listen(app);
    const denied = await request("/posts/p1");
    expect(denied.status).toBe(401);
    expect(denied.headers.get("www-authenticate")).toBe("Bearer");
  });

  it("turns a thrown assert into a problem and passes other errors on", async () => {
    const { middleware, errorHandler, withPermDock } = createPermDock(policy, {
      subject: () => memberUser,
    });
    const app = express();
    app.use(middleware());
    app.get(
      "/posts/:id",
      withPermDock((req) => {
        req.permdock.assert(permissions.post.update, otherPost);
      }),
    );
    app.get(
      "/boom",
      withPermDock(() => {
        throw new Error("boom");
      }),
    );
    app.use(errorHandler());
    const request = await listen(app);

    const denied = await request("/posts/p2");
    expect(denied.status).toBe(403);
    expect(denied.headers.get("content-type")).toContain(
      "application/problem+json",
    );

    const other = await request("/boom");
    expect(other.status).toBe(500);
  });

  it("answers its own errors with Problem Details without errorHandler", async () => {
    const { middleware } = createPermDock(policy, {
      subject: () => memberUser,
      webBotAuth: async () => {
        throw new InvalidSignatureError(
          invalidSignatureProblem("bad signature"),
        );
      },
    });
    const app = express();
    app.use(middleware());
    app.get("/posts", (_req, res) => {
      res.json({ ok: true });
    });
    const request = await listen(app);
    const rejected = await request("/posts");
    expect(rejected.status).toBe(403);
    expect(rejected.headers.get("content-type")).toContain(
      "application/problem+json",
    );
  });

  it("mounts the AuthZEN evaluations handler", async () => {
    const { permdockHandler } = createPermDock(policy, {
      subject: () => memberUser,
    });
    const app = express();
    app.use(express.json());
    app.use("/api/permdock", permdockHandler());
    const request = await listen(app);
    const response = await request("/api/permdock", {
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
    });
    // SAFETY: AuthZEN response JSON produced by permdockHandler under test.
    const body = (await response.json()) as {
      readonly evaluations: readonly { readonly decision: boolean }[];
    };
    expect(body.evaluations[0]?.decision).toBe(true);
  });
});
