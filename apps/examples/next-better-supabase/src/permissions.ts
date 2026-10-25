import { definePermissions, defineRoles, resource } from "permdock";
import { z } from "zod";

/**
 * The CentraKit shape: staff hold one role per organization in `memberships`,
 * and a portal contact holds `contact` on their customer through
 * `contacts.user_id`.
 */
const Staff = z.object({
  id: z.uuid(),
  organization_id: z.uuid(),
  user_id: z.uuid(),
  name: z.string(),
  title: z.string(),
});

const Quote = z.object({
  id: z.uuid(),
  organization_id: z.uuid(),
  customer_id: z.uuid(),
  title: z.string(),
  amount_minor: z.number().int(),
  currency: z.string().length(3),
});

export const permissions = definePermissions({
  staff: resource(Staff, {
    id: "id",
    actions: ["read"],
    collection: ["list"],
    relations: {
      organization: { field: "organization_id", memberOf: "organization" },
    },
  }),
  quotes: resource(Quote, {
    id: "id",
    actions: ["read", "update"],
    collection: ["list"],
    relations: {
      organization: { field: "organization_id", memberOf: "organization" },
      customer: { field: "customer_id", memberOf: "customer" },
    },
  }),
  // better-supabase's audit block checks these at the organization (`blocks.audit.permissions`).
  audit: resource({ collection: ["read", "revert"] }),
  // Editing `public.role_permissions`, the app's own copy of each custom role.
  roles: resource({ collection: ["manage"] }),
});

export const roles = defineRoles({
  owner: { on: "organization" },
  member: { on: "organization" },
  contact: { on: "customer", assignable: false },
});
