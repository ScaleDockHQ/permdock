import { defineOperations, definePermissions, resource } from "permdock";
import { z } from "zod";

export const Invoice = z.object({
  id: z.string(),
  orgId: z.string(),
});

export const permissions = definePermissions({
  invoice: resource(Invoice, {
    id: "id",
    actions: ["read", "send"],
    relations: { org: { field: "orgId", memberOf: "tenant" } },
  }),
});

export const operations = defineOperations(permissions, {
  read_invoice: {
    permission: permissions.invoice.read,
    meta: { risk: "low", effects: ["read"], title: "Read an invoice" },
  },
  send_invoice: {
    permission: permissions.invoice.send,
    meta: { risk: "medium", effects: ["send"], title: "Send an invoice" },
  },
});

export const invoices: Readonly<Record<string, z.infer<typeof Invoice>>> = {
  inv_42: { id: "inv_42", orgId: "acme" },
};
