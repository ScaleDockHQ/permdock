import { defineMiddleware, pipeline } from "@supabase/middleware";
import { describe, expect, expectTypeOf, it } from "vitest";

import type { SinkEvent } from "../../src/core/interfaces.ts";
import type { SupabaseJwtClaims } from "../../src/supabase/middleware.ts";
import type { PermDockOf } from "../fixtures/vocabulary.ts";

import {
  memoryApprovalStore,
  resolveApproval,
} from "../../src/approvals/index.ts";
import { APPROVAL_HEADER } from "../../src/approvals/types.ts";
import { verifyWebBotAuth } from "../../src/server/web-bot-auth.ts";
import { createPermDock } from "../../src/supabase/middleware.ts";
import { subjectFromSupabase } from "../../src/supabase/subject.ts";
import {
  otherPost,
  ownPost,
  permissions,
  policy,
} from "../fixtures/quick-start.ts";

type FixtureClaimsConfig =
  | { readonly claims: SupabaseJwtClaims | null }
  | undefined;

const withFixtureClaims = defineMiddleware<
  "jwtClaims",
  FixtureClaimsConfig,
  Record<never, never>,
  SupabaseJwtClaims | null
>({
  key: "jwtClaims",
  run: (config) => async () => ({ jwtClaims: config?.claims ?? null }),
});

const memberClaims: SupabaseJwtClaims = {
  sub: "u1",
  role: "authenticated",
  user_role: "member",
  tenant_id: "o1",
};

const adminClaims: SupabaseJwtClaims = {
  sub: "u2",
  role: "authenticated",
  user_role: "admin",
  tenant_id: "o1",
};

const subjectOptions = {
  roles: "user_role",
  tenant: "tenant_id",
  declared: ["member", "admin"],
} as const;

function request(path: string, init?: RequestInit): Request {
  return new Request(`http://localhost${path}`, init);
}

describe("permdock/supabase/middleware", () => {
  it("contributes a request-scoped instance built from ctx.jwtClaims", async () => {
    const { withPermDock } = createPermDock(policy, {
      subject: (ctx) => subjectFromSupabase(ctx.jwtClaims, subjectOptions),
    });
    const fetch = pipeline(
      [withFixtureClaims({ claims: memberClaims }), withPermDock()],
      async (_req, ctx) => {
        expectTypeOf(ctx.permdock).toEqualTypeOf<PermDockOf<typeof policy>>();
        return Response.json({
          id: ctx.permdock.subject.principal?.id,
          own: ctx.permdock.can(permissions.post.update, ownPost),
          other: ctx.permdock.can(permissions.post.update, otherPost),
        });
      },
    );
    const response = await fetch(request("/posts/p1", { method: "PATCH" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: "u1",
      own: true,
      other: false,
    });
  });

  it("treats null claims as the anonymous subject and never throws", async () => {
    const { withPermDock } = createPermDock(policy, {
      subject: (ctx) => subjectFromSupabase(ctx.jwtClaims, subjectOptions),
    });
    const fetch = pipeline(
      [withFixtureClaims(), withPermDock()],
      async (_req, ctx) =>
        Response.json({
          anonymous: ctx.permdock.subject.principal === null,
          can: ctx.permdock.can(permissions.post.read, ownPost),
        }),
    );
    const response = await fetch(request("/posts"));
    expect(await response.json()).toEqual({ anonymous: true, can: false });
  });

  it("falls back to anonymous when the subject resolver throws", async () => {
    const { withPermDock } = createPermDock(policy, {
      subject: () => {
        throw new Error("boom");
      },
    });
    const fetch = pipeline(
      [withFixtureClaims({ claims: memberClaims }), withPermDock()],
      async (_req, ctx) =>
        Response.json({ anonymous: ctx.permdock.subject.principal === null }),
    );
    const response = await fetch(request("/posts"));
    expect(await response.json()).toEqual({ anonymous: true });
  });

  it("short-circuits with Problem Details when protect denies", async () => {
    const { withPermDock } = createPermDock(policy, {
      subject: (ctx) => subjectFromSupabase(ctx.jwtClaims, subjectOptions),
    });
    const fetch = pipeline(
      [
        withFixtureClaims({ claims: memberClaims }),
        withPermDock({
          protect: permissions.post.publish,
          data: () => ownPost,
        }),
      ],
      async () => Response.json({ ok: true }),
    );
    const response = await fetch(
      request("/posts/p1/publish", { method: "POST" }),
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("content-type")).toContain(
      "application/problem+json",
    );
    // SAFETY: Problem Details JSON produced by the middleware under test.
    const body = (await response.json()) as { readonly type: string };
    expect(body.type).toBe("https://permdock.dev/problems/denied");
  });

  it("lets a granted protect through and contributes the same instance", async () => {
    const { withPermDock } = createPermDock(policy, {
      subject: (ctx) => subjectFromSupabase(ctx.jwtClaims, subjectOptions),
    });
    const fetch = pipeline(
      [
        withFixtureClaims({ claims: adminClaims }),
        withPermDock({
          protect: permissions.post.publish,
          data: () => ownPost,
        }),
      ],
      async (_req, ctx) =>
        Response.json({ id: ctx.permdock.subject.principal?.id }),
    );
    const response = await fetch(
      request("/posts/p1/publish", { method: "POST" }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "u2" });
  });

  it("returns 404 when protect data loads nothing", async () => {
    const { withPermDock } = createPermDock(policy, {
      subject: (ctx) => subjectFromSupabase(ctx.jwtClaims, subjectOptions),
    });
    const fetch = pipeline(
      [
        withFixtureClaims({ claims: adminClaims }),
        withPermDock({ protect: permissions.post.update, data: () => null }),
      ],
      async () => Response.json({ ok: true }),
    );
    const response = await fetch(
      request("/posts/missing", { method: "PATCH" }),
    );
    expect(response.status).toBe(404);
  });

  it("passes the context and request to the tenant option", async () => {
    const seen: string[] = [];
    const { withPermDock } = createPermDock(policy, {
      subject: (ctx) =>
        subjectFromSupabase(ctx.jwtClaims, {
          ...subjectOptions,
          memberships: "memberships",
        }),
      tenant: (ctx, req) => {
        seen.push(ctx.jwtClaims?.sub ?? "anon");
        return new URL(req.url).searchParams.get("tenant") ?? undefined;
      },
    });
    const fetch = pipeline(
      [
        withFixtureClaims({
          claims: {
            ...memberClaims,
            memberships: [
              { tenant: "o1", roles: ["member"] },
              { tenant: "o2", roles: ["member"] },
            ],
          },
        }),
        withPermDock(),
      ],
      async (_req, ctx) =>
        Response.json({ tenant: ctx.permdock.subject.principal?.tenant }),
    );
    const o2 = await (await fetch(request("/posts?tenant=o2"))).json();
    expect(o2).toEqual({ tenant: "o2" });
    const o1 = await (await fetch(request("/posts?tenant=o1"))).json();
    expect(o1).toEqual({ tenant: "o1" });
    // A requested tenant with no matching membership is no tenant.
    const o3 = await (await fetch(request("/posts?tenant=o3"))).json();
    expect(o3).toEqual({});
    expect(seen).toEqual(["u1", "u1", "u1"]);
  });

  it("forwards decisions to the sink", async () => {
    const events: SinkEvent[] = [];
    const { withPermDock } = createPermDock(policy, {
      subject: (ctx) => subjectFromSupabase(ctx.jwtClaims, subjectOptions),
      sink: {
        write: (batch) => {
          events.push(...batch);
        },
      },
    });
    const fetch = pipeline(
      [withFixtureClaims({ claims: memberClaims }), withPermDock()],
      async (_req, ctx) => {
        ctx.permdock.can(permissions.post.update, ownPost);
        return new Response(null, { status: 204 });
      },
    );
    await fetch(request("/posts/p1", { method: "PATCH" }));
    const decision = events.find((event) => event.type === "decision");
    expect(decision?.type).toBe("decision");
    if (decision?.type === "decision") {
      expect(decision.permission).toBe("post.update");
      expect(decision.outcome).toBe("granted");
    }
  });

  it("returns approval-required as a Problem and resumes with a stored approval", async () => {
    const store = memoryApprovalStore();
    const { withPermDock } = createPermDock(policy, {
      subject: (ctx) => subjectFromSupabase(ctx.jwtClaims, subjectOptions),
      store,
    });
    const fetch = pipeline(
      [
        withFixtureClaims({ claims: memberClaims }),
        withPermDock({ protect: permissions.post.delete, data: () => ownPost }),
      ],
      async () => new Response(null, { status: 204 }),
    );
    const pending = await fetch(request("/posts/p1", { method: "DELETE" }));
    expect(pending.status).toBe(403);
    // SAFETY: Problem Details JSON produced by the middleware under test.
    const body = (await pending.json()) as {
      readonly type: string;
      readonly token?: string;
    };
    expect(body.type).toBe("https://permdock.dev/problems/approval-required");
    expect(typeof body.token).toBe("string");
    await resolveApproval(store, body.token!, {
      status: "approved",
      by: { principal: { id: "u9", roles: ["admin"] }, context: {} },
    });
    const resumed = await fetch(
      request("/posts/p1", {
        method: "DELETE",
        headers: { [APPROVAL_HEADER]: body.token! },
      }),
    );
    expect(resumed.status).toBe(204);
  });

  it("exposes the evaluations handler and openapi hooks", async () => {
    const { permdockHandler, openapi } = createPermDock(policy, {
      subject: (ctx) => subjectFromSupabase(ctx.jwtClaims, subjectOptions),
    });
    const handler = pipeline(
      [withFixtureClaims({ claims: memberClaims })],
      permdockHandler(),
    );
    const response = await handler(
      request("/api/permdock", {
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
      }),
    );
    // SAFETY: AuthZEN response JSON produced by permdockHandler under test.
    const body = (await response.json()) as {
      readonly evaluations: readonly { readonly decision: boolean }[];
    };
    expect(body.evaluations[0]?.decision).toBe(true);
    expect(openapi.security(permissions.post.update)).toEqual({
      security: [{ oauth2: ["post:update"] }],
      "x-permdock-permissions": ["post.update"],
    });
  });

  it("rejects a claimed Web Bot Auth signature before the handler", async () => {
    const { withPermDock } = createPermDock(policy, {
      subject: (ctx) => subjectFromSupabase(ctx.jwtClaims, subjectOptions),
      webBotAuth: (incoming) =>
        verifyWebBotAuth(incoming, {
          verify: true,
          keys: { lookup: () => undefined },
        }),
    });
    const fetch = pipeline(
      [withFixtureClaims({ claims: memberClaims }), withPermDock()],
      async () => Response.json({ ok: true }),
    );
    const response = await fetch(
      request("/posts", {
        headers: {
          "Signature-Input":
            'sig1=("@method");created=1700000000;keyid="bot-1";alg="ed25519"',
          Signature: "sig1=:AAAA:",
          "Signature-Agent": '"https://agents.example.com"',
        },
      }),
    );
    expect(response.status).toBe(403);
    // SAFETY: Problem Details JSON produced by the middleware under test.
    const body = (await response.json()) as { readonly type: string };
    expect(body.type).toBe("https://permdock.dev/problems/invalid-signature");
  });

  it("requires an upstream jwtClaims contribution at the type level", () => {
    const { withPermDock } = createPermDock(policy, {
      subject: (ctx) => subjectFromSupabase(ctx.jwtClaims, subjectOptions),
    });
    // @ts-expect-error: withPermDock declares jwtClaims as a prerequisite.
    pipeline([withPermDock()], async () => new Response(null));
    const { permdockHandler } = createPermDock(policy, {
      subject: (ctx) => subjectFromSupabase(ctx.jwtClaims, subjectOptions),
    });
    // @ts-expect-error: the evaluations handler needs jwtClaims upstream too.
    pipeline([], permdockHandler());
    expect(true).toBe(true);
  });

  it("accepts the @supabase/server JWTClaims shape structurally", () => {
    interface JWTClaims {
      sub: string;
      iss?: string;
      role?: string;
      app_metadata?: Record<string, unknown>;
      [key: string]: unknown;
    }
    expectTypeOf<JWTClaims>().toExtend<SupabaseJwtClaims>();
  });
});
