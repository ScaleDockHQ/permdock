import type { Principal } from "permdock";

import { actor, allow, definePolicy, plan, relation, role } from "permdock";

import { permissions, roles } from "./permissions.ts";

export { permissions, roles };

const definition = {
  scopes: {
    organization: { key: "organization_id" },
    team: { key: "team_id", within: "organization" },
    customer: { key: "customer_id", within: "organization" },
  },
  // The loaders pass a full Subject from `subjectFromBetterSupabase`, which skips this mapper.
  subject: (user: Principal | null) => user,
  roles: [
    role(
      roles.owner,
      [
        allow([
          permissions.staff,
          permissions.quotes.read,
          permissions.quotes.list,
          permissions.quotes.update,
          permissions.audit,
          permissions.roles,
          permissions.members,
          permissions.organization,
          permissions.teams,
          permissions.settings,
          permissions.approvals,
          permissions.access_requests,
          permissions.api_keys,
          permissions.service_accounts,
          permissions.usage,
          permissions.sso,
          permissions.relations,
          permissions.automations,
          permissions.billing,
          permissions.impersonation,
        ]),
        allow(permissions.quotes.send, { where: { status: "draft" } }),
        allow(permissions.quotes.approve, {
          where: { status: "sent" },
          approval: "human",
        }),
        // A draft is the only quote an owner may remove.
        allow(permissions.quotes.delete, { where: { status: "draft" } }),
      ],
      { on: "organization", min: 1 },
    ),
    role(
      roles.admin,
      [
        allow([
          permissions.staff,
          permissions.quotes.read,
          permissions.quotes.list,
          permissions.quotes.update,
          permissions.quotes.create,
          permissions.members.read,
          permissions.members.invite,
          permissions.teams,
          permissions.settings.read,
          permissions.settings.update,
          permissions.approvals,
          permissions.audit.read,
        ]),
      ],
      { on: "organization" },
    ),
    role(
      roles.member,
      [allow([permissions.staff.read, permissions.staff.list])],
      { on: "organization" },
    ),
    role(roles.lead, [allow(permissions.teams.read)], { on: "team" }),
    role(
      roles.contact,
      [allow([permissions.quotes.read, permissions.quotes.list])],
      { on: "customer", min: 0 },
    ),
    // Only share links hold it: a guest reads the one quote the link names.
    role("guest", [allow(permissions.quotes.read)], { on: permissions.quotes }),
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
  grants: [
    // A plan grantee is not compiled into RLS. The running policy adds it.
    allow(permissions.quotes.list, {
      to: relation(permissions.quotes, "customer"),
    }),
  ],
};

/** The policy RLS compiles. A plan grantee cannot be compiled into SQL. */
export const policy = definePolicy({ permissions, roles }, definition);

/**
 * The policy the app runs. `billing.read` on the pro plan is checked in
 * process.
 */
export const appPolicy = definePolicy(
  { permissions, roles },
  {
    ...definition,
    grants: [
      ...definition.grants,
      allow(permissions.billing.read, { to: plan("pro") }),
      allow(permissions.quotes.create, {
        to: roles.owner,
        limit: { count: 100, per: 86_400 },
      }),
    ],
  },
);
