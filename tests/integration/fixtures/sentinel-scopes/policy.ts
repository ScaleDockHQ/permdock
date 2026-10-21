import {
  allow,
  definePermissions,
  definePolicy,
  defineRoles,
  resource,
  role,
} from "permdock";
import { z } from "zod";

/**
 * Two scopes whose names appear nowhere in PermDock's defaults, so generated
 * SQL that still says `tenant`, `team` or `organization` fails to apply.
 */
const Widget = z.object({
  id: z.string(),
  zorg_id: z.string(),
  zcust_id: z.string(),
});

export const permissions = definePermissions({
  widget: resource(Widget, {
    id: "id",
    actions: ["read", "update"],
    relations: {
      zorg: { field: "zorg_id", memberOf: "zorg" },
      zcust: { field: "zcust_id", memberOf: "zcust" },
    },
  }),
});

export const roles = defineRoles({
  admin: { on: "zorg" },
  viewer: { on: "zorg" },
  contact: { on: "zcust" },
});

export const policy = definePolicy(
  { permissions, roles },
  {
    scopes: {
      zorg: { key: "zorg_id" },
      zcust: { key: "zcust_id", within: "zorg" },
    },
    roles: [
      role(roles.admin, [
        allow(permissions.widget.read),
        allow(permissions.widget.update),
      ]),
      role(roles.viewer, [allow(permissions.widget.read)]),
      role(roles.contact, [allow(permissions.widget.read)]),
    ],
    subject: () => null,
  },
);
