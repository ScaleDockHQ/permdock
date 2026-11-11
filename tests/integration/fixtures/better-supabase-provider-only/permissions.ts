import { definePermissions, defineRoles, resource } from "permdock";
import { z } from "zod";

const Project = z.object({
  id: z.uuid(),
  organization_id: z.string(),
  name: z.string(),
});

export const permissions = definePermissions({
  projects: resource(Project, {
    id: "id",
    actions: ["read", "update", "delete"],
    collection: ["list"],
    relations: {
      organization: { field: "organization_id", memberOf: "organization" },
    },
  }),
  organizations: resource({ collection: ["manage"] }),
});

export const roles = defineRoles({
  owner: { on: "organization" },
  member: { on: "organization" },
  "platform-admin": {},
});
