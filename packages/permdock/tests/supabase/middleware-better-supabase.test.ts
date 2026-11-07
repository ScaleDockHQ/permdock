import { defineMiddleware, pipeline } from "@supabase/middleware";
import { describe, expect, it } from "vitest";

import type { SubjectCache } from "../../src/core/subject-cache.ts";
import type { SupabaseRpcClient } from "../../src/supabase/index.ts";
import type { SupabaseJwtClaims } from "../../src/supabase/middleware.ts";

import { definePermDock } from "../../src/better-supabase/index.ts";
import {
  allow,
  definePermissions,
  definePolicy,
  resource,
  role,
} from "../../src/index.ts";
import { createPermDock } from "../../src/supabase/middleware.ts";

const permissions = definePermissions({
  post: resource({ actions: ["read"] }),
});
const policy = definePolicy(permissions, {
  roles: [role("member", [allow(permissions.post.read)])],
  subject: (user: { id: string; roles: string[] } | null) => user,
});

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

const withClaims = defineMiddleware<
  "jwtClaims",
  undefined,
  Record<never, never>,
  SupabaseJwtClaims | null
>({ key: "jwtClaims", run: () => async () => ({ jwtClaims: claims }) });

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

describe("createPermDock(better-supabase definition)", () => {
  it("takes the one factory for an app with both adapters and maps claims with its subject options", async () => {
    const app = definePermDock(policy, { subject });
    const { withPermDock } = createPermDock(app);
    const handler = pipeline([withClaims(), withPermDock()], async (_r, ctx) =>
      Response.json({
        id: ctx.permdock.subject.principal?.id,
        own: ctx.permdock.can(permissions.post.read, {}),
      }),
    );
    const response = await handler(new Request("http://localhost/p"), {});
    expect(await response.json()).toStrictEqual({ id: "u1", own: true });
  });

  it("reads memberships through the definition's client and its one subject cache", async () => {
    const calls: string[] = [];
    const reads: string[] = [];
    const subjects: SubjectCache = {
      record: (id) => {
        reads.push(id);
        return null;
      },
      seed: () => undefined,
      evict: () => undefined,
    };
    const app = definePermDock(policy, {
      subject,
      subjects,
      client: () => client(calls),
    });
    const { withPermDock } = createPermDock(app);
    const handler = pipeline([withClaims(), withPermDock()], async () =>
      Response.json({}),
    );
    await handler(new Request("http://localhost/p"), {});
    expect(calls).toContain("permdock.subject_for");
    expect(reads).toContain("u1");
  });
});
