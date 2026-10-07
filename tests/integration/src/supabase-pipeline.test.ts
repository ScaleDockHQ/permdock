import type { Principal } from "permdock";

import { withClaims } from "@supabase/server/middleware/claims";
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
import { saasJwks, signSaasToken } from "permdock/testing/saas";
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
