import { pipeline } from "@supabase/middleware";
import { withClaims } from "@supabase/server/middleware/claims";
import { Hono } from "hono";

import { flags, reviewQueue } from "./flags.ts";
import { isDevUser, jwks, mintToken } from "./keys.ts";
import { permdockHandler, withPermDock } from "./permdock.ts";
import { ownPost, permissions } from "./permissions.ts";
import { toHono } from "./to-hono.ts";

const posts = new Map([
  [ownPost.id, ownPost],
  ["p2", { id: "p2", authorId: "u9", orgId: "o1", published: true }],
]);

// Stands in for the database read a real app would await here.
async function postFrom(request: Request): Promise<typeof ownPost | null> {
  const [, , id = ""] = new URL(request.url).pathname.split("/");
  await Promise.resolve();
  return posts.get(id) ?? null;
}

// Contribute `ctx.permdock` and decide inside the handler.
const patchPost = pipeline(
  [withClaims({ jwks }), withPermDock()],
  async (request, ctx): Promise<Response> => {
    const post = await postFrom(request);
    if (post === null) {
      return Response.json({ ok: false }, { status: 404 });
    }
    if (!ctx.permdock.can(permissions.post.update, post)) {
      return Response.json({ ok: false }, { status: 403 });
    }
    return Response.json({ ok: true, by: ctx.permdock.subject.principal?.id });
  },
);

// Guard the route: a denial short-circuits with RFC 9457 Problem Details, so
// the handler only runs for a granted decision.
const publishPost = pipeline(
  [
    withClaims({ jwks }),
    withPermDock({
      protect: permissions.post.publish,
      data: async (_ctx, request) => {
        const post = await postFrom(request);
        return post;
      },
    }),
  ],
  async (request): Promise<Response> => {
    const post = await postFrom(request);
    return post === null
      ? Response.json({ ok: false }, { status: 404 })
      : Response.json({ ok: true });
  },
);

// AuthZEN evaluations for the caller's own claims.
const evaluations = pipeline([withClaims({ jwks })], permdockHandler());

// The same entries inside Hono: the bridge publishes `jwtClaims` and
// `permdock` on `c.var`. It replaces `@supabase/server/adapters/hono`, which
// is removed on 1 December 2026.
const hono = new Hono()
  .basePath("/hono")
  .use("*", toHono([withClaims({ jwks }), withPermDock()]))
  .patch("/posts/:id", (c) => {
    const post = posts.get(c.req.param("id")) ?? null;
    if (post === null) {
      return c.json({ ok: false }, 404);
    }
    if (!c.var.permdock.can(permissions.post.update, post)) {
      return c.json({ ok: false }, 403);
    }
    return c.json({ ok: true, by: c.var.permdock.subject.principal?.id });
  });

async function devToken(request: Request): Promise<Response> {
  const user = new URL(request.url).pathname.slice("/dev/token/".length);
  if (!isDevUser(user)) {
    return Response.json({ ok: false }, { status: 404 });
  }
  return Response.json({ token: await mintToken(user) });
}

type Route = (request: Request) => Promise<Response>;

function routeFor(request: Request): Route | null {
  const { pathname } = new URL(request.url);
  if (request.method === "GET" && pathname.startsWith("/dev/token/")) {
    return devToken;
  }
  if (request.method === "POST" && pathname === "/api/permdock") {
    return evaluations;
  }
  if (request.method === "GET" && pathname === "/posts/review-queue") {
    return reviewQueue;
  }
  if (request.method === "GET" && pathname === "/flags") {
    return flags;
  }
  if (pathname.startsWith("/hono/")) {
    return async (honoRequest) => {
      const response = await hono.fetch(honoRequest);
      return response;
    };
  }
  if (
    request.method === "POST" &&
    /^\/posts\/[^/]+\/publish$/u.test(pathname)
  ) {
    return publishPost;
  }
  if (request.method === "PATCH" && /^\/posts\/[^/]+$/u.test(pathname)) {
    return patchPost;
  }
  return null;
}

export const app = {
  async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/health") {
      return Response.json({ ok: true });
    }
    const route = routeFor(request);
    if (route === null) {
      return new Response(null, { status: 404 });
    }
    const response = await route(request);
    return response;
  },
};
