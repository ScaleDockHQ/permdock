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
  status: z.enum(["draft", "sent", "approved"]),
  team_id: z.uuid().nullable(),
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
    actions: ["read", "update", "send", "approve", "delete"],
    collection: ["list", "create"],
    relations: {
      organization: { field: "organization_id", memberOf: "organization" },
      customer: { field: "customer_id", memberOf: "customer" },
      team: { field: "team_id", memberOf: "team" },
    },
  }),
  // better-supabase's audit block checks these at the organization (`blocks.audit.permissions`).
  audit: resource({ collection: ["read", "revert"] }),
  // Editing `public.role_permissions`, the app's own copy of each custom role.
  roles: resource({ collection: ["manage"] }),
  // Keys the better-supabase blocks check. A collection leaf has no row
  // condition, so the provider marks it sqlComplete.
  members: resource({
    collection: ["invite", "read", "remove", "update_role"],
  }),
  organization: resource({
    collection: ["update", "delete", "transfer_ownership"],
  }),
  teams: resource({ collection: ["read", "manage"] }),
  settings: resource({ collection: ["read", "update", "manage"] }),
  approvals: resource({ collection: ["read", "request", "manage"] }),
  access_requests: resource({
    collection: ["read", "create", "manage", "emergency", "review"],
  }),
  impersonation: resource({ collection: ["start", "read", "revoke"] }),
  api_keys: resource({ collection: ["manage", "own"] }),
  service_accounts: resource({ collection: ["read", "manage"] }),
  usage: resource({ collection: ["read", "record"] }),
  sso: resource({ collection: ["manage"] }),
  relations: resource({ collection: ["read", "manage"] }),
  automations: resource({ collection: ["read", "write", "publish", "manage"] }),
  billing: resource({ collection: ["read"] }),
});

export const roles = defineRoles({
  owner: { on: "organization", assigns: ["admin", "member", "lead"] },
  admin: { on: "organization", assigns: ["member", "lead"] },
  member: { on: "organization" },
  lead: { on: "team" },
  contact: { on: "customer", assignable: false },
});
