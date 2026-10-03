import { definePermissions, defineRoles, resource } from "permdock";
import { z } from "zod";

export const QuoteSchema = z.object({
  id: z.string(),
  organization_id: z.string(),
  customer_id: z.string(),
  title: z.string(),
  status: z.enum(["draft", "sent", "approved"]),
  total: z.number(),
});

export type Quote = z.infer<typeof QuoteSchema>;

export const MemberSchema = z.object({
  id: z.string(),
  organization_id: z.string(),
});

const inOrganization = {
  organization: { field: "organization_id", memberOf: "organization" },
} as const;

export const permissions = definePermissions({
  quote: resource(QuoteSchema, {
    id: "id",
    actions: ["read", "approve", "delete"],
    collection: ["list"],
    relations: {
      ...inOrganization,
      customer: { field: "customer_id", memberOf: "customer" },
    },
  }),
  member: resource(MemberSchema, {
    id: "id",
    actions: [],
    collection: ["list", "manage"],
    relations: inOrganization,
  }),
});

export const roles = defineRoles({
  admin: {},
  member: {},
  contact: {},
});

export type RoleName = keyof typeof roles;
