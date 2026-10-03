import { definePermissions, resource } from "permdock";
import { z } from "zod";

const Invoice = z.object({
  id: z.string(),
  orgId: z.string(),
  ownerId: z.string(),
});

const AuditLog = z.object({ id: z.string(), orgId: z.string() });

export const permissions = definePermissions({
  invoice: resource(Invoice, {
    id: "id",
    actions: ["read", "refund"],
    collection: ["list"],
  }),
  auditLog: resource(AuditLog, { id: "id", actions: ["read"] }),
});
