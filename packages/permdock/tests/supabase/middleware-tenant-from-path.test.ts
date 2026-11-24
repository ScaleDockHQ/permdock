import { defineMiddleware, pipeline } from "@supabase/middleware";
import { describe, expect, it } from "vitest";

import type { SupabaseJwtClaims } from "../../src/supabase/middleware.ts";

import {
  createPermDock,
  tenantFromPath,
} from "../../src/supabase/middleware.ts";
import {
  tenantCaller,
  tenantPermissions,
  tenantPolicy,
  tenantSlugs,
} from "../fixtures/tenant-path.ts";

const withFixtureClaims = defineMiddleware<
  "jwtClaims",
  undefined,
  Record<never, never>,
  SupabaseJwtClaims | null
>({
  key: "jwtClaims",
  run: () => async () => ({ jwtClaims: { sub: tenantCaller.id } }),
});

const { withPermDock } = createPermDock(tenantPolicy, {
  subject: (ctx) => (ctx.jwtClaims === null ? null : tenantCaller),
  tenant: tenantFromPath({
    path: "/orgs/:org",
    param: "org",
    resolve: (slug) => tenantSlugs[slug],
  }),
});

const fetch = pipeline(
  [withFixtureClaims(), withPermDock()],
  async (_request, ctx) =>
    Response.json({
      tenant: ctx.permdock.subject.principal?.tenant ?? null,
      create: ctx.permdock.decide(tenantPermissions.project.create).outcome,
    }),
);

async function answer(path: string): Promise<unknown> {
  const response = await fetch(new Request(`http://localhost${path}`));
  return response.json();
}

describe("permdock/supabase/middleware tenantFromPath", () => {
  it("uses the resolved id when the caller holds a membership there", async () => {
    await expect(answer("/orgs/acme/mcp")).resolves.toStrictEqual({
      tenant: "o1",
      create: "granted",
    });
  });

  it("gives no tenant for an unheld tenant or an unknown slug", async () => {
    for (const path of ["/orgs/globex/mcp", "/orgs/nobody/mcp"]) {
      await expect(answer(path)).resolves.toStrictEqual({
        tenant: null,
        create: "denied",
      });
    }
  });
});
