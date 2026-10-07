import type { SupabaseSuspension } from "permdock/supabase";

import { fromJunction } from "permdock/supabase";

import { permissions } from "../policy.ts";

/** Organization B is suspended; its members may still read invoices and assets, to export them before a purge. */
export const suspension: SupabaseSuspension = {
  users: { table: "profiles", id: "id", disabledAt: "disabled_at" },
  scopes: {
    organization: {
      table: "organization",
      id: "id",
      disabledAt: "disabled_at",
      keep: [permissions.invoice.read, permissions.asset.read],
    },
    customer: {
      table: "customer",
      id: "id",
      status: "status",
      active: ["active", "prospect"],
    },
  },
};

export const memberships = {
  scopes: {
    organization: {
      table: "organization_users",
      user: "user_id",
      role: "role",
      via: "via",
      columns: { organization: "organization_id" },
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
      expiresAt: "expires_at",
    },
  },
};

export const sources = [
  fromJunction({
    table: "organization_users",
    scope: "organization",
    id: "organization_id",
    roles: "role",
    via: "staff",
    suspension,
  }),
  fromJunction({
    table: "customer_contacts",
    scope: "customer",
    id: "customer_id",
    within: { organization: "organization_id" },
    roles: "role",
    via: "contact",
    expiresAt: "expires_at",
    suspension,
  }),
];

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
  supabase: { hook: { memberships: sources } },
};
