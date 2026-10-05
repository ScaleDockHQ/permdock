import type { SqlQuery, SupabaseSuspension } from "permdock/supabase";

import { fromJunction } from "permdock/supabase";

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

/** The role a membership row references, read as `roles.key`. */
export const roleKey = {
  through: "roles",
  on: { role_id: "id" },
  column: "key",
} as const;

/**
 * CentraKit's real tables: staff in `organization_users (user_id,
 * organization_id, role_id references roles(id))`, portal contacts in
 * `contacts.user_id`.
 */
export function sources(query?: SqlQuery) {
  const shared = query === undefined ? { suspension } : { query, suspension };
  return [
    fromJunction({
      table: "organization_users",
      scope: "organization",
      roles: roleKey,
      via: "staff",
      ...shared,
    }),
    fromJunction({
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
