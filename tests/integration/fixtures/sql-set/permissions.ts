import { definePermissions, defineRoles, resource } from "permdock";
import { z } from "zod";

export const File = z.object({ id: z.string(), ownerId: z.string() });

export const permissions = definePermissions({
  file: resource(File, { id: "id", actions: ["read"] }),
});

export const roles = defineRoles({ member: {} });
