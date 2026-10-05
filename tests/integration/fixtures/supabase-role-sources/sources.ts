import type { SqlQuery } from "permdock/supabase";

import { fromJunction } from "permdock/supabase";

/** An organization membership row holding a plan `tier` key and a `roles` reference. */
export function membership(query?: SqlQuery) {
  return fromJunction({
    table: "organization_users",
    scope: "organization",
    id: "organization_id",
    roles: {
      sources: [
        "tier",
        { through: "roles", on: { role_id: "id" }, column: "key" },
      ],
    },
    ...(query === undefined ? {} : { query }),
  });
}
