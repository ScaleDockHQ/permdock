import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import {
  createPermDock,
  type PermDockRequest,
} from "../../src/fastify/index.ts";
import {
  memberUser,
  otherPost,
  ownPost,
  permissions,
  policy,
} from "../fixtures/quick-start.ts";

const apps: ReturnType<typeof Fastify>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

describe("permdock/fastify", () => {
  it("sets a request-scoped instance and protects routes", async () => {
    const { permdock, protect } = createPermDock(policy, {
      subject: () => memberUser,
    });
    const app = Fastify();
    apps.push(app);
    await app.register(permdock);
    // SAFETY: the permdock plugin registered above decorates every request with permdock.
    app.delete<{ Params: { id: string } }>(
      "/posts/:id",
      {
        preHandler: protect(permissions.post.update, (request) =>
          request.params.id === "p1" ? ownPost : otherPost,
        ),
      },
      (request) => ({
        ok: true,
        via: (request as PermDockRequest<{ Params: { id: string } }>).permdock
          .subject.principal?.id,
      }),
    );

    const allowed = await app.inject({ method: "DELETE", url: "/posts/p1" });
    expect(allowed.statusCode).toBe(200);
    expect(allowed.json()).toEqual({ ok: true, via: "u1" });

    const denied = await app.inject({ method: "DELETE", url: "/posts/p2" });
    expect(denied.statusCode).toBe(403);
    expect(denied.headers["content-type"]).toContain(
      "application/problem+json",
    );
  });

  it("answers 401 with a bare Bearer challenge to a caller without credentials", async () => {
    const { protect } = createPermDock(policy, {
      subject: () => null,
    });
    const app = Fastify();
    apps.push(app);
    app.get(
      "/posts/:id",
      {
        preHandler: protect(permissions.post.read, () => ownPost),
      },
      () => ({ ok: true }),
    );
    const denied = await app.inject({ method: "GET", url: "/posts/p1" });
    expect(denied.statusCode).toBe(401);
    expect(denied.headers["www-authenticate"]).toBe("Bearer");
  });

  it("builds no instance for a route with config permdock false", async () => {
    let resolved = 0;
    const { permdock } = createPermDock(policy, {
      subject: () => {
        resolved += 1;
        return memberUser;
      },
    });
    const app = Fastify();
    await app.register(permdock);
    app.get("/health", { config: { permdock: false } }, () => ({ ok: true }));
    app.get("/posts", () => ({ ok: true }));
    await app.inject("/health");
    expect(resolved).toBe(0);
    await app.inject("/posts");
    expect(resolved).toBe(1);
    await app.close();
  });

  it("mounts the AuthZEN evaluations handler", async () => {
    const { permdockHandler } = createPermDock(policy, {
      subject: () => memberUser,
    });
    const app = Fastify();
    apps.push(app);
    await app.register(permdockHandler, { prefix: "/api/permdock" });
    const response = await app.inject({
      method: "POST",
      url: "/api/permdock",
      headers: { "content-type": "application/json" },
      payload: {
        evaluations: [
          {
            resource: { type: "post", properties: ownPost },
            action: { name: "update" },
          },
        ],
      },
    });
    // SAFETY: AuthZEN response JSON produced by permdockHandler under test.
    const body = response.json() as {
      readonly evaluations: readonly { readonly decision: boolean }[];
    };
    expect(body.evaluations[0]?.decision).toBe(true);
  });
});
