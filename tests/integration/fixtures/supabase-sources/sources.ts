import type { SqlQuery, SupabaseSuspension } from "permdock/supabase";

import { fromJunction, fromTable } from "permdock/supabase";

export const suspension: SupabaseSuspension = {
  users: { table: "profiles", id: "id", disabledAt: "disabled_at" },
  scopes: {
    organization: {
      table: "organization",
      id: "id",
      disabledAt: "disabled_at",
    },
  },
};

/** The app's membership sources; the hook generator reads the same objects. */
export function sources(query?: SqlQuery) {
  const shared = query === undefined ? { suspension } : { query, suspension };
  return [
    fromTable({
      table: "memberships",
      columns: {
        via: "via",
        expiresAt: "expires_at",
        managedBy: "managed_by",
        seats: "seats",
      },
      ...shared,
    }),
    fromJunction({
      table: "customer_contacts",
      scope: "customer",
      within: { organization: "organization_id" },
      roles: ["contact"],
      via: "contact",
      ...shared,
    }),
  ];
}
