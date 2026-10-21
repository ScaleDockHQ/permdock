import type { Principal } from "permdock";

import { actor, allow, definePolicy, role } from "permdock";

import { permissions, roles } from "./permissions.ts";

export { permissions, roles };

export const policy = definePolicy(
  { permissions, roles },
  {
    scopes: {
      organization: { key: "organization_id" },
      customer: { key: "customer_id", within: "organization" },
    },
    // The loaders pass a full Subject from `subjectFromBetterSupabase`, which skips this mapper.
    subject: (user: Principal | null) => user,
    roles: [
      role(
        roles.owner,
        [
          allow([
            permissions.staff.read,
            permissions.staff.list,
            permissions.quotes.read,
            permissions.quotes.list,
            permissions.quotes.update,
            permissions.audit.view,
            permissions.audit.revert,
          ]),
        ],
        { on: "organization", min: 1 },
      ),
      role(
        roles.member,
        [allow([permissions.staff.read, permissions.staff.list])],
        { on: "organization" },
      ),
      role(
        roles.contact,
        [allow([permissions.quotes.read, permissions.quotes.list])],
        { on: "customer", min: 0 },
      ),
      // Only share links hold it: a guest reads the one quote the link names.
      role("guest", [allow(permissions.quotes.read)], {
        on: permissions.quotes,
      }),
    ],
    // A better-supabase support session or an agent token reaches only what the owner holds
    // and this names; a `read_only` session keeps the read and list keys.
    delegations: [
      {
        from: roles.owner,
        to: actor("support"),
        permissions: [permissions.quotes],
      },
      {
        from: roles.owner,
        to: actor("agent"),
        permissions: [permissions.quotes],
      },
    ],
  },
);
