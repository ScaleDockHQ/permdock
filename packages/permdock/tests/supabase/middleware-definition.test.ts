import { defineMiddleware, pipeline } from "@supabase/middleware";
import { describe, expect, it } from "vitest";

import type { SupabaseRpcClient } from "../../src/supabase/index.ts";
import type { SupabaseJwtClaims } from "../../src/supabase/middleware.ts";

import {
  allow,
  definePermissions,
  definePolicy,
  resource,
  role,
} from "../../src/index.ts";
import { definePermDock } from "../../src/supabase/index.ts";
import { createPermDock } from "../../src/supabase/middleware.ts";

const permissions = definePermissions({
  post: resource({ actions: ["read"] }),
});
const policy = definePolicy(permissions, {
  roles: [role("member", [allow(permissions.post.read)])],
  subject: (user: { id: string; roles: string[] } | null) => user,
});

type Config = { readonly claims: SupabaseJwtClaims | null } | undefined;

const withFixtureContext = defineMiddleware<
  "jwtClaims",
  Config,
  Record<never, never>,
  SupabaseJwtClaims | null
>({
  key: "jwtClaims",
  run: (config) => async () => ({ jwtClaims: config?.claims ?? null }),
});

const withFixtureAdmin = (admin: SupabaseRpcClient | undefined) =>
  defineMiddleware<
    "supabaseAdmin",
    undefined,
    Record<never, never>,
    SupabaseRpcClient | undefined
  >({
    key: "supabaseAdmin",
    run: () => async () => ({ supabaseAdmin: admin }),
  })();

const claims: SupabaseJwtClaims = {
  sub: "u1",
  role: "authenticated",
  user_role: "member",
  tenant_id: "o1",
};

const subject = {
  claims: { roles: "user_role", scope: "tenant", id: "tenant_id" },
  declared: ["member", "admin"],
} as const;

function client(calls: string[]): SupabaseRpcClient {
  return {
    schema: (name) => ({
      async rpc(fn) {
        calls.push(`${name}.${fn}`);
        return { data: null, error: null };
      },
    }),
  };
}

const request = new Request("http://localhost/posts/p1", { method: "PATCH" });

async function run(
  withPermDock: ReturnType<typeof createPermDock>["withPermDock"],
  admin?: SupabaseRpcClient,
): Promise<unknown> {
  const handler = pipeline(
    [withFixtureContext({ claims }), withFixtureAdmin(admin), withPermDock()],
    async (_req, ctx) =>
      Response.json({
        id: ctx.permdock.subject.principal?.id,
        own: ctx.permdock.can(permissions.post.read, {}),
      }),
  );
  const response = await handler(new Request(request), {});
  return response.json();
}

describe("createPermDock(definition)", () => {
  it("defaults subject to the definition's claim mapping", async () => {
    const app = definePermDock(policy, { subject });
    const { withPermDock } = createPermDock(app);
    expect(await run(withPermDock)).toStrictEqual({ id: "u1", own: true });
  });

  it("reads memberships through the definition's client", async () => {
    const calls: string[] = [];
    const app = definePermDock(policy, {
      subject,
      client: () => client(calls),
    });
    const { withPermDock } = createPermDock(app);
    await run(withPermDock);
    expect(calls).toContain("permdock.subject_for");
  });

  it("falls back to ctx.supabaseAdmin when the definition has no client", async () => {
    const calls: string[] = [];
    const app = definePermDock(policy, { subject });
    const { withPermDock } = createPermDock(app);
    await run(withPermDock, client(calls));
    expect(calls).toContain("permdock.subject_for");
  });

  it("reads only claims without any client", async () => {
    const calls: string[] = [];
    const app = definePermDock(policy, { subject });
    const { withPermDock } = createPermDock(app);
    await run(withPermDock);
    expect(calls).toStrictEqual([]);
  });

  it("rejects a plain policy without subject", () => {
    // SAFETY: the test calls the plain-policy overload without its required option.
    const call = createPermDock as (
      policy: unknown,
      options: object,
    ) => unknown;
    expect(() => call(policy, {})).toThrow(/needs a subject/u);
  });
});
