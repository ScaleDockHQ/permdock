import { definePermissions, principal, resource } from "permdock";
import { z } from "zod";

export const Job = z.object({
  id: z.string(),
  orgId: z.string(),
  ownerId: z.string(),
});

export const Invite = z.object({ id: z.string(), orgId: z.string() });

export const permissions = definePermissions({
  job: resource(Job, {
    id: "id",
    actions: ["read", "update", "delete"],
    collection: ["create"],
    relations: { org: { field: "orgId", memberOf: "tenant" } },
    levels: { own: { ownerId: principal.id }, all: {} },
  }),
  invite: resource(Invite, {
    id: "id",
    actions: ["read"],
    collection: ["create"],
    relations: { org: { field: "orgId", memberOf: "tenant" } },
  }),
});
