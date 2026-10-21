import type { Principal } from "permdock";

import {
  allow,
  definePermissions,
  definePolicy,
  defineRoles,
  resource,
  role,
} from "permdock";
import { z } from "zod";

/** An organization with teams; a team member reads the team's boards. */
const Board = z.object({
  id: z.string(),
  organization_id: z.string(),
  team_id: z.string(),
});

export const permissions = definePermissions({
  board: resource(Board, {
    id: "id",
    actions: ["read"],
    relations: {
      organization: { field: "organization_id", memberOf: "organization" },
      team: { field: "team_id", memberOf: "team" },
    },
  }),
});

export const roles = defineRoles({
  member: { on: "organization" },
  teammate: { on: "team" },
});

export const policy = definePolicy(
  { permissions, roles },
  {
    scopes: {
      organization: { key: "organization_id" },
      team: { key: "team_id", within: "organization" },
    },
    subject: (user: Principal | null) => user,
    roles: [
      role(roles.member, [], { on: "organization" }),
      role(roles.teammate, [allow(permissions.board.read)], { on: "team" }),
    ],
  },
);
