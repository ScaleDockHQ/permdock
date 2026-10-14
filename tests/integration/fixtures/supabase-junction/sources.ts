import type { SqlQuery } from "permdock/supabase";

import { junctionMembershipSource } from "permdock/supabase";

/** better-supabase's organization membership table, in its own schema. */
export function membership(query?: SqlQuery) {
  return junctionMembershipSource({
    table: "app.memberships",
    scope: "organization",
    id: "organization_id",
    roles: "role",
    ...(query === undefined ? {} : { query }),
  });
}
