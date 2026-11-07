import {
  allow,
  definePermissions,
  definePolicy,
  resource,
  role,
} from "permdock";
import { z } from "zod";

/** Two resources with distinct field names, so a bundle shows which one it kept. */
export const permissions = definePermissions({
  alpha: resource(
    z.object({
      id: z.uuid(),
      organization_id: z.uuid(),
      alphaField: z.string().min(2),
      alphaStatus: z.enum(["open", "closed"]),
    }),
    {
      id: "id",
      actions: ["read"],
      relations: {
        org: { field: "organization_id", memberOf: "organization" },
      },
    },
  ),
  beta: resource(
    z.object({
      id: z.uuid(),
      organization_id: z.uuid(),
      betaField: z.string().min(2),
      betaStatus: z.enum(["open", "closed"]),
    }),
    {
      id: "id",
      actions: ["read"],
      relations: {
        org: { field: "organization_id", memberOf: "organization" },
      },
    },
  ),
});

export const policy = definePolicy(permissions, {
  scopes: { organization: { key: "organization_id" } },
  subject: () => null,
  roles: [
    role(
      "member",
      [allow(permissions.alpha.read), allow(permissions.beta.read)],
      { on: "organization" },
    ),
  ],
});
