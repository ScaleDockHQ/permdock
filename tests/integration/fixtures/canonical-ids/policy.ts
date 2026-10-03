import {
  allow,
  definePermissions,
  definePolicy,
  resource,
  role,
} from "permdock";
import { z } from "zod";

const Doc = z.object({ id: z.string(), orgId: z.string() });

export const permissions = definePermissions({
  doc: resource(Doc, {
    id: "id",
    actions: ["read"],
    relations: { org: { field: "orgId", memberOf: "tenant" } },
  }),
});

export const policy = definePolicy(permissions, {
  roles: [role("member", [allow(permissions.doc.read)], { on: "tenant" })],
  scopes: { tenant: { key: "orgId" } },
  subject: () => null,
});
