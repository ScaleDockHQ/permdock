import { definePermissions, resource } from "permdock";
import { z } from "zod";

export const Invoice = z.object({ id: z.string(), orgId: z.string() });

export const permissions = definePermissions({
  invoice: resource(Invoice, {
    id: "id",
    actions: ["read", "pay"],
    relations: { org: { field: "orgId", memberOf: "tenant" } },
  }),
});

export const invoice = { id: "inv_42", orgId: "acme" };
