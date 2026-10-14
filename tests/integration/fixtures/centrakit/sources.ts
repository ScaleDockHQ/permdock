import type { SqlQuery, SupabaseSuspension } from "permdock/supabase";

import {
  junctionMembershipSource,
  tableMembershipSource,
} from "permdock/supabase";

export const suspension: SupabaseSuspension = {
  users: { table: "profiles", id: "user_id", disabledAt: "disabled_at" },
  scopes: {
    organization: {
      table: "organizations",
      id: "id",
      disabledAt: "disabled_at",
    },
  },
};

/** Staff from `memberships`, portal contacts from `contacts.user_id`; the hook and the helpers read the same objects. */
export function sources(query?: SqlQuery) {
  const shared = query === undefined ? { suspension } : { query, suspension };
  return [
    tableMembershipSource({
      table: "memberships",
      columns: { via: "via", expiresAt: "expires_at" },
      ...shared,
    }),
    junctionMembershipSource({
      table: "contacts",
      scope: "customer",
      id: "customer_id",
      within: { organization: "organization_id" },
      roles: ["contact"],
      via: "contact",
      ...shared,
    }),
  ];
}
