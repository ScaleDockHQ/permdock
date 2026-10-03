import { defineMiddleware, pipeline } from "@supabase/middleware";
import { describe, expect, it } from "vitest";

import type { SupabaseJwtClaims } from "../../src/supabase/middleware.ts";

import { createPermDock } from "../../src/supabase/middleware.ts";
import { subjectFromSupabase } from "../../src/supabase/subject.ts";
import { permissions, policy } from "../fixtures/quick-start.ts";

const memberClaims: SupabaseJwtClaims = {
  sub: "u1",
  role: "authenticated",
  user_role: "member",
  tenant_id: "o1",
};

const withClaims = defineMiddleware<
  "jwtClaims",
  undefined,
  Record<never, never>,
  SupabaseJwtClaims | null
>({
  key: "jwtClaims",
  run: () => async () => ({ jwtClaims: memberClaims }),
});

const subjectOptions = {
  roles: "user_role",
  tenant: "tenant_id",
  declared: ["member", "admin"],
} as const;

describe("permdock/supabase/middleware edges", () => {
  it("protects a collection without a data loader", async () => {
    const { withPermDock } = createPermDock(policy, {
      subject: (ctx) => subjectFromSupabase(ctx.jwtClaims, subjectOptions),
    });
    const fetch = pipeline(
      [withClaims(), withPermDock({ protect: permissions.post.list })],
      async (_request, ctx) =>
        new Response(ctx.permdock.subject.principal?.id ?? "none"),
    );
    const response = await fetch(new Request("http://localhost/posts"));
    expect(await response.text()).toBe("u1");
  });

  it("serves the snapshot on GET and answers 405 for other methods", async () => {
    const { permdockHandler } = createPermDock(policy, {
      subject: (ctx) => subjectFromSupabase(ctx.jwtClaims, subjectOptions),
    });
    const handler = pipeline([withClaims()], permdockHandler());
    const get = await handler(new Request("http://localhost/api/permdock"));
    const put = await handler(
      new Request("http://localhost/api/permdock", { method: "PUT" }),
    );
    expect({
      get: get.status,
      put: put.status,
      allow: put.headers.get("Allow"),
    }).toEqual({ get: 200, put: 405, allow: "GET, POST" });
  });

  it("rethrows a build failure that is not a signature error", async () => {
    const { withPermDock } = createPermDock(policy, {
      subject: (ctx) => subjectFromSupabase(ctx.jwtClaims, subjectOptions),
      pdp: async () => {
        throw new Error("pdp factory failed");
      },
    });
    const fetch = pipeline(
      [withClaims(), withPermDock()],
      async () => new Response("reached"),
    );
    await expect(fetch(new Request("http://localhost/posts"))).rejects.toThrow(
      "pdp factory failed",
    );
  });
});
