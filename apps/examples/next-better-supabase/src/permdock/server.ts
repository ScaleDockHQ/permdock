import "server-only";
import { subjectFromBetterSupabase } from "permdock/better-supabase";
import { createPermDock } from "permdock/next";

import { bsb, freshMemberships } from "../lib/supabase/server.ts";
import { policy } from "../policy.ts";

// `bsb.cached()` caps `stale` at the token's expiry, so the subject resolves
// only inside a `'use cache: private'` loader such as `loadSnapshot`.
// `endpoint: false`: no `/api/permdock` route exists, every check is local.
export const { getSnapshot, PermDockProvider } = createPermDock(policy, {
  subject: async () => subjectFromBetterSupabase((await bsb.cached()).session),
  memberships: freshMemberships,
  endpoint: false,
});
