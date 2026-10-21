import { defineOperations, definePermissions, resource } from "permdock";
import { z } from "zod";

export const Invoice = z.object({ id: z.string(), orgId: z.string() });

export const permissions = definePermissions({
  invoice: resource(Invoice, {
    id: "id",
    actions: ["read", "pay"],
    relations: { org: { field: "orgId", memberOf: "tenant" } },
  }),
});

const invoices: Readonly<Record<string, z.infer<typeof Invoice>>> = {
  inv_42: { id: "inv_42", orgId: "acme" },
};

export const operations = defineOperations(permissions, {
  "invoice.show": {
    permission: permissions.invoice.read,
    data: (input: { readonly id: string }) => invoices[input.id] ?? null,
    meta: { risk: "low", effects: ["read"], title: "Show an invoice" },
  },
  "invoice.pay": {
    permission: permissions.invoice.pay,
    data: (input: { readonly id: string }) => invoices[input.id] ?? null,
    meta: { risk: "high", effects: ["spend"], title: "Pay an invoice" },
  },
});
