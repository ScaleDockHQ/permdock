import type { SqlQuery } from "permdock/supabase";

import { fromJunction, fromTable } from "permdock/supabase";

/** Staff from `memberships`, portal contacts from `contacts.user_id`: the hook and the SQL helpers read the same rows. */
export function sources(options: { readonly query?: SqlQuery } = {}) {
  return [
    fromTable({ table: "memberships", ...options }),
    fromJunction({
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
