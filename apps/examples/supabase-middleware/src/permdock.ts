import { subjectFromSupabase } from "permdock/supabase";
import { createPermDock } from "permdock/supabase/middleware";

import { policy } from "./policy.ts";

// `ctx.jwtClaims` is the JWKS-verified payload from `withClaims`; `null` is the
// anonymous caller. `subjectFromSupabase` never reads `user_metadata`.
export const { withPermDock, permdockHandler } = createPermDock(policy, {
  subject: (ctx) =>
    subjectFromSupabase(ctx.jwtClaims, {
      roles: "user_role",
      tenant: "tenant_id",
      memberships: "memberships",
      declared: ["member", "admin"],
    }),
});
