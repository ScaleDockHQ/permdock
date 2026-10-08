import type { FastifyRequest } from "fastify";

import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { toRequest } from "../../src/fastify/http.ts";
import {
  createPermDock,
  type PermDockRequest,
} from "../../src/fastify/index.ts";
import {
  memberUser,
  otherPost,
  permissions,
  policy,
} from "../fixtures/quick-start.ts";

const apps: ReturnType<typeof Fastify>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function fastifyRequest(fields: {
  readonly headers: Record<string, string | string[] | undefined>;
  readonly method: string;
  readonly body?: unknown;
}): FastifyRequest {
  // SAFETY: toRequest reads only headers, protocol, url, method and body.
  return { protocol: "http", url: "/x", ...fields } as FastifyRequest;
}

describe("fastify toRequest", () => {
  it("reads an array host and array headers, and defaults the host", () => {
    const arrayHost = toRequest(
      fastifyRequest({
        headers: {
          host: ["api.test"],
          accept: ["a/b", "c/d"],
          skip: undefined,
        },
        method: "GET",
      }),
    );
    const noHost = toRequest(
      fastifyRequest({ headers: { host: [] }, method: "HEAD" }),
    );
    expect({
      arrayHost: arrayHost.url,
      accept: arrayHost.headers.get("accept"),
      noHost: noHost.url,
    }).toEqual({
      arrayHost: "http://api.test/x",
      accept: "a/b, c/d",
      noHost: "http://localhost/x",
    });
  });

  it("serialises the parsed body", async () => {
    const empty = toRequest(fastifyRequest({ headers: {}, method: "POST" }));
    const text = toRequest(
      fastifyRequest({ headers: {}, method: "POST", body: "raw" }),
    );
    const json = toRequest(
      fastifyRequest({ headers: {}, method: "POST", body: { a: 1 } }),
    );
    const typed = toRequest(
      fastifyRequest({
        headers: { "content-type": "application/vnd.x+json" },
        method: "PATCH",
        body: { a: 2 },
      }),
    );
    expect([
      await empty.text(),
      await text.text(),
      json.headers.get("content-type"),
      await json.text(),
      typed.headers.get("content-type"),
    ]).toEqual([
      "",
      "raw",
      "application/json",
      '{"a":1}',
      "application/vnd.x+json",
    ]);
  });
});

describe("permdock/fastify edge cases", () => {
  it("maps a thrown denial to a problem and hands other errors to the previous handler", async () => {
    const { permdock } = createPermDock(policy, { subject: () => memberUser });
    const app = Fastify();
    apps.push(app);
    app.setErrorHandler(async (_error, _request, reply) => {
      await reply.code(599).send({ previous: true });
    });
    await app.register(permdock);
    app.get("/denied", (request) => {
      // SAFETY: the permdock plugin registered above decorates every request with permdock.
      (request as PermDockRequest).permdock.assert(
        permissions.post.update,
        otherPost,
      );
      return { ok: true };
    });
    app.get("/boom", () => {
      throw new Error("boom");
    });
    const denied = await app.inject({ method: "GET", url: "/denied" });
    const boom = await app.inject({ method: "GET", url: "/boom" });
    expect({
      denied: denied.statusCode,
      problem: denied.headers["content-type"],
      boom: boom.statusCode,
      body: boom.json(),
    }).toEqual({
      denied: 403,
      problem: expect.stringContaining("application/problem+json"),
      boom: 599,
      body: { previous: true },
    });
  });

  it("resolves the actor from the Fastify request", async () => {
    const { permdock } = createPermDock(policy, {
      subject: () => memberUser,
      actor: (request) => ({ id: request.url, kind: "agent" }),
    });
    const app = Fastify();
    apps.push(app);
    await app.register(permdock);
    app.get(
      "/posts",
      (request) =>
        // SAFETY: the permdock plugin decorates every request before the handler runs.
        (request as PermDockRequest).permdock.subject.actor,
    );
    const posts = await app.inject({ method: "GET", url: "/posts" });
    expect(posts.json()).toEqual({ id: "/posts", kind: "agent" });
  });

  it("protects a collection without a loader and serves the snapshot on GET", async () => {
    const { protect, permdockHandler } = createPermDock(policy, {
      subject: () => memberUser,
    });
    const app = Fastify();
    apps.push(app);
    app.get(
      "/posts",
      { preHandler: protect(permissions.post.list) },
      (request) => ({
        // SAFETY: protect decorates the request with permdock before the handler runs.
        via: (request as PermDockRequest).permdock.subject.principal?.id,
      }),
    );
    await app.register(permdockHandler, { prefix: "/api/permdock" });
    const posts = await app.inject({ method: "GET", url: "/posts" });
    const snapshot = await app.inject({ method: "GET", url: "/api/permdock" });
    expect({
      posts: posts.json(),
      snapshot: snapshot.statusCode,
    }).toEqual({ posts: { via: "u1" }, snapshot: 200 });
  });

  it("withPermDock passes the decorated request to the route", async () => {
    const { permdock, withPermDock } = createPermDock(policy, {
      subject: () => memberUser,
    });
    const app = Fastify();
    apps.push(app);
    await app.register(permdock);
    app.get(
      "/can",
      withPermDock((request) => ({
        update: request.permdock.can(permissions.post.update, otherPost),
      })),
    );
    const response = await app.inject({ method: "GET", url: "/can" });
    expect(response.json()).toEqual({ update: false });
  });
});
