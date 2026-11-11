import type { Principal } from "permdock";

import { allow, definePolicy, role } from "permdock";
import { defineSeeds } from "permdock/seeds";

import { permissions, roles } from "./permissions.ts";

export { permissions, roles };

const { projects } = permissions;

export const policy = definePolicy(
  { permissions, roles },
  {
    scopes: { organization: { key: "organization_id" } },
    subject: (user: Principal | null) => user,
    roles: [
      role(
        roles.owner,
        [
          allow([
            projects.read,
            projects.list,
            projects.update,
            projects.delete,
          ]),
        ],
        { on: "organization", assigns: ["owner", "member"] },
      ),
      role(roles.member, [allow([projects.read, projects.list])], {
        on: "organization",
      }),
      role(roles["platform-admin"], [allow(permissions.organizations.manage)]),
    ],
  },
);

/** The personas better-supabase's access matrix signs in as come from these. */
export const seeds = defineSeeds(policy, {
  fixtures: {
    users: {
      ada: { id: "00000000-0000-4000-8000-0000000000a1" },
      bo: { id: "00000000-0000-4000-8000-0000000000b2" },
    },
    tenants: { acme: { id: "acme" } },
    memberships: [
      { user: "ada", tenant: "acme", roles: ["owner"] },
      { user: "bo", tenant: "acme", roles: ["member"] },
    ],
  },
});
