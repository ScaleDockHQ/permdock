import type { SqlQuery, SupabaseSuspension } from "permdock/supabase";

import { fromJunction } from "permdock/supabase";

import { permissions } from "../policy.ts";

export const suspension: SupabaseSuspension = {
  memberships: { keep: [permissions.asset.read] },
};

export const memberships = {
  scopes: {
    organization: {
      table: "organization_users",
      user: "user_id",
      role: "role",
      via: "via",
      columns: { organization: "organization_id" },
      disabledAt: "disabled_at",
    },
    customer: {
      table: "customer_contacts",
      user: "user_id",
      role: "role",
      via: "via",
      columns: {
        customer: "customer_id",
        organization: "organization_id",
      },
      disabledAt: "disabled_at",
    },
  },
};

export function sources(
  options: {
    readonly suspension?: SupabaseSuspension;
    readonly query?: SqlQuery;
  } = {},
) {
  return [
    fromJunction({
      table: "organization_users",
      scope: "organization",
      id: "organization_id",
      roles: "role",
      via: "staff",
      disabledAt: "disabled_at",
      ...options,
    }),
    fromJunction({
      table: "customer_contacts",
      scope: "customer",
      id: "customer_id",
      within: { organization: "organization_id" },
      roles: "role",
      via: "contact",
      disabledAt: "disabled_at",
      ...options,
    }),
  ];
}

export default {
  permissions: "../policy.ts",
  policy: "../policy.ts",
  rls: {
    dialect: "supabase",
    tenantType: "text",
    authorize: "jwt",
    suspension,
    memberships,
  },
  supabase: { hook: { memberships: sources({ suspension }) } },
};
