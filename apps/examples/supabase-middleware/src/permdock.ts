import { definePermDock } from "permdock/supabase";
import { createPermDock, tenantFromPath } from "permdock/supabase/middleware";

import { policy } from "./policy.ts";

// `ctx.jwtClaims` is the JWKS-verified payload from `withClaims`; `null` is the
// anonymous caller. The claim mapping never reads `user_metadata`. Without a
// `client`, only the token's claims count; pass `client` to read memberships.
const app = definePermDock(policy, {
  profile: "dev",
  subject: {
    claims: {
      roles: "user_role",
      tenant: "tenant_id",
      memberships: "memberships",
    },
    declared: ["member", "admin"],
  },
});

// Stands in for the app's organisations table: slug to tenant id.
const organisations: ReadonlyMap<string, string> = new Map([
  ["acme", "o1"],
  ["globex", "o2"],
]);

// `/orgs/:org/...` names the tenant by slug. The id is the active tenant only
// when the token holds a membership there; any other path keeps `tenant_id`.
export const { withPermDock, permdockHandler } = createPermDock(app, {
  tenant: tenantFromPath({
    path: "/orgs/:org",
    param: "org",
    resolve: async (slug) => {
      await Promise.resolve();
      return organisations.get(slug) ?? null;
    },
  }),
});
