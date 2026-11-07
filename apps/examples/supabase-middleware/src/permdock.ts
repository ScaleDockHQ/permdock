import { definePermDock } from "permdock/supabase";
import { createPermDock } from "permdock/supabase/middleware";

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

export const { withPermDock, permdockHandler } = createPermDock(app);
