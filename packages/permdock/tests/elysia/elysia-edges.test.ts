import { Elysia } from "elysia";
import { describe, expect, it } from "vitest";

import type { ElysiaPermDockContext } from "../../src/elysia/index.ts";

import { createPermDock } from "../../src/elysia/index.ts";
import {
  memberUser,
  otherPost,
  permissions,
  policy,
} from "../fixtures/quick-start.ts";

describe("permdock/elysia edge cases", () => {
  it("protects a collection route without a loader and decorates the context", async () => {
    const { protect } = createPermDock(policy, { subject: () => memberUser });
    const bodies: unknown[] = [{ title: "x" }, "raw text"];
    const results = [];
    for (const body of bodies) {
      const ctx = {
        request: new Request("http://localhost/posts", { method: "POST" }),
        body,
      };
      const response = await protect(permissions.post.list)(ctx);
      // SAFETY: protect decorates ctx with permdock when it grants.
      const decorated = ctx as unknown as ElysiaPermDockContext;
      results.push({
        response,
        principal: decorated.permdock.subject.principal?.id,
        data: decorated.permdockData,
      });
    }
    const json = {
      request: new Request("http://localhost/posts", {
        method: "POST",
        headers: { "content-type": "application/json" },
      }),
      body: { title: "y" },
    };
    expect(await protect(permissions.post.list)(json)).toBeUndefined();
    expect(results).toStrictEqual([
      { response: undefined, principal: "u1", data: undefined },
      { response: undefined, principal: "u1", data: undefined },
    ]);
  });

  it("resolves the actor from the Elysia context", async () => {
    const { middleware } = createPermDock(policy, {
      subject: () => memberUser,
      actor: (ctx) => ({ id: new URL(ctx.request.url).host, kind: "agent" }),
    });
    const app = new Elysia()
      .use(middleware())
      .get("/posts", (ctx) => ctx.permdock.subject.actor);
    const response = await app.handle(new Request("http://bots.test/posts"));
    expect(await response.json()).toStrictEqual({
      id: "bots.test",
      kind: "agent",
    });
  });

  it("turns a thrown assert in a route into a problem response", async () => {
    const { middleware } = createPermDock(policy, {
      subject: () => memberUser,
    });
    const app = new Elysia().use(middleware()).get("/posts/p2", (ctx) => {
      // SAFETY: the middleware() plugin derives ctx.permdock for every route.
      (ctx as unknown as ElysiaPermDockContext).permdock.assert(
        permissions.post.update,
        otherPost,
      );
      return { ok: true };
    });
    const response = await app.handle(new Request("http://localhost/posts/p2"));
    expect({
      status: response.status,
      type: response.headers.get("content-type"),
    }).toStrictEqual({
      status: 403,
      type: expect.stringContaining("application/problem+json"),
    });
  });

  it("serves the snapshot on GET from the evaluations handler", async () => {
    const { permdockHandler } = createPermDock(policy, {
      subject: () => memberUser,
    });
    const app = new Elysia().group("/api/permdock", (group) =>
      group.use(permdockHandler()),
    );
    const response = await app.handle(
      new Request("http://localhost/api/permdock"),
    );
    expect(response.status).toBe(200);
  });
});
