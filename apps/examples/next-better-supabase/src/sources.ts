import type { SqlQuery } from "permdock/supabase";

import { blockMembershipSource } from "permdock/better-supabase";
import { junctionMembershipSource } from "permdock/supabase";

/**
 * Staff from `organization_memberships`, the memberships block's table; portal
 * contacts from `contacts.user_id`. The hook and the SQL helpers read the same
 * rows.
 */
export function sources(options: { readonly query?: SqlQuery } = {}) {
  return [
    blockMembershipSource({
      table: "public.organization_memberships",
      columns: { disabledAt: null },
      ...options,
    }),
    junctionMembershipSource({
      table: "contacts",
      scope: "customer",
      id: "customer_id",
      within: { organization: "organization_id" },
      roles: ["contact"],
      via: "contact",
      ...options,
    }),
  ];
}
