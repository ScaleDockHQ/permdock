import type { PermDock, Principal } from "permdock";

import { pipeline } from "@supabase/middleware";
import { withCors } from "@supabase/middleware/cors";
import { withSupabase } from "@supabase/server";
import { withClaims } from "@supabase/server/middleware/claims";
import { withRequiredClaims } from "@supabase/server/middleware/required-claims";
import { Hono } from "hono";
import {
  allow,
  definePermissions,
  definePolicy,
  principal,
  resource,
  role,
} from "permdock";
import { subjectFromSupabase } from "permdock/supabase";
import { createPermDock } from "permdock/supabase/middleware";
import {
  saasJwks,
  saasPermissions,
  saasPolicy,
  saasPrincipal,
  saasProject,
  signSaasToken,
} from "permdock/testing/saas";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { toHono } from "./support/to-hono.ts";

const permissions = definePermissions({
  post: resource(z.object({ id: z.string(), authorId: z.string() }), {
    id: "id",
    actions: ["update"],
  }),
});

const policy = definePolicy(permissions, {
  roles: [
    role("member", [
      allow(permissions.post.update, { where: { authorId: principal.id } }),
    ]),
  ],
  subject: (user: Principal | null) => user,
});

const posts = new Map([
  ["own", { id: "own", authorId: "u1" }],
  ["other", { id: "other", authorId: "u9" }],
]);

const { withPermDock } = createPermDock(policy, {
  subject: (ctx) => subjectFromSupabase(ctx.jwtClaims, { roles: "user_role" }),
});

const token = (sub: string) =>
  signSaasToken(sub, {
    memberships: false,
    claims: { role: "authenticated", user_role: "member" },
  });

describe("withPermDock composed with @supabase/server entries", () => {
  const sp = saasPermissions;
  const secret = "sb_secret_billing_0123456789";
  const env = {
    url: "http://127.0.0.1:54321",
    publishableKeys: { default: "sb_publishable_0123456789" },
    secretKeys: { billing: secret },
    jwks: saasJwks,
  };
  const saas = createPermDock(saasPolicy, {
    subject: (ctx) =>
      ctx.jwtClaims === null ? null : saasPrincipal(ctx.jwtClaims.sub, "acme"),
    tenant: "acme",
    secretKeys: {
      billing: {
        id: "svc_billing",
        tenant: "acme",
        roles: ["admin"],
        permissions: [sp.project.update],
      },
    },
  });
  const decide = async (_request: Request, ctx: { permdock: PermDock }) =>
    Response.json({
      principal: ctx.permdock.subject.principal?.id ?? null,
      update: ctx.permdock.can(sp.project.update, saasProject("p1")),
      delete: ctx.permdock.can(sp.project.delete, saasProject("p1")),
    });
  const call = (
    fetch: (request: Request) => Promise<Response>,
    headers: Record<string, string> = {},
  ) => fetch(new Request("http://localhost/projects/p1", { headers }));

  it("reads a user after withRequiredClaims and stops anonymous callers first", async () => {
    const fetch = pipeline(
      [withRequiredClaims({ jwks: saasJwks }), saas.withPermDock()],
      async (request, ctx) => decide(request, ctx),
    );
    expect((await call(fetch)).status).toBe(401);
    const bob = await call(fetch, {
      authorization: `Bearer ${await signSaasToken("bob")}`,
    });
    expect(await bob.json()).toEqual({
      principal: "bob",
      update: true,
      delete: true,
    });
    const hank = await call(fetch, {
      authorization: `Bearer ${await signSaasToken("hank")}`,
    });
    expect(await hank.json()).toMatchObject({ update: false });
  });

  it("turns a named secret key from withSupabase into the declared service principal", async () => {
    const fetch = pipeline(
      [withSupabase({ auth: ["user", "secret:*"], env }), saas.withPermDock()],
      async (request, ctx) => decide(request, ctx),
    );
    const key = await call(fetch, { apikey: secret });
    expect(key.status).toBe(200);
    expect(await key.json()).toEqual({
      principal: "svc_billing",
      update: true,
      delete: false,
    });
    const user = await call(fetch, {
      authorization: `Bearer ${await signSaasToken("bob")}`,
    });
    expect(await user.json()).toMatchObject({ principal: "bob" });
    expect((await call(fetch, { apikey: "sb_secret_wrong" })).status).toBe(401);
  });

  it("keeps CORS headers on a PermDock denial", async () => {
    const fetch = pipeline(
      [
        withCors({ origin: "https://app.example" }),
        withClaims({ jwks: saasJwks }),
        saas.withPermDock({ protect: sp.project.delete }),
      ],
      async () => new Response(null, { status: 204 }),
    );
    const denied = await call(fetch, {
      origin: "https://app.example",
      authorization: `Bearer ${await signSaasToken("hank")}`,
    });
    expect(denied.status).toBe(403);
    expect(denied.headers.get("content-type")).toContain(
      "application/problem+json",
    );
    expect(denied.headers.get("access-control-allow-origin")).toBe(
      "https://app.example",
    );
  });
});

describe("@supabase/middleware entries in Hono through the pipeline bridge", () => {
  const app = new Hono()
    .use("*", toHono([withClaims({ jwks: saasJwks }), withPermDock()]))
    .patch("/posts/:id", (c) => {
      const post = posts.get(c.req.param("id")) ?? null;
      if (post === null) {
        return c.json({ ok: false }, 404);
      }
      return c.var.permdock.can(permissions.post.update, post)
        ? c.json({ ok: true, by: c.var.jwtClaims?.sub })
        : c.json({ ok: false }, 403);
    });

  const patch = async (id: string, bearer?: string) =>
    app.request(`/posts/${id}`, {
      method: "PATCH",
      headers:
        bearer === undefined ? {} : { authorization: `Bearer ${bearer}` },
    });

  it("publishes jwtClaims and permdock on c.var", async () => {
    const response = await patch("own", await token("u1"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, by: "u1" });
  });

  it("denies another author's post", async () => {
    expect((await patch("other", await token("u1"))).status).toBe(403);
  });

  it("treats a request without a token as anonymous", async () => {
    expect((await patch("own")).status).toBe(403);
  });

  it("answers an invalid token with withClaims' 401 before PermDock runs", async () => {
    const response = await patch("own", "not-a-jwt");
    expect(response.status).toBe(401);
    expect(response.headers.get("x-supabase-server-error")).toBe("INVALID_JWT");
  });
});
