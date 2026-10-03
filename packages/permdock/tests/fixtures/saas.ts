import { z } from "zod";

import {
  allow,
  anyone,
  crud,
  definePermissions,
  definePlans,
  definePolicy,
  defineRoles,
  deny,
  principal,
  resource,
} from "../../src/index.ts";

const Project = z.object({
  id: z.string(),
  orgId: z.string(),
  ownerId: z.string(),
  archived: z.boolean(),
});

export const permissions = definePermissions({
  project: resource(
    Project,
    crud({ relations: { org: { field: "orgId", memberOf: "tenant" } } }),
  ),
  member: resource({
    actions: ["assignRole"],
    collection: ["list", "invite"],
    relations: { org: { field: "orgId", memberOf: "tenant" } },
  }),
  billing: resource({ collection: ["read", "manage"] }),
  settings: resource({ collection: ["manage"] }),
  audit: resource({ collection: ["read"] }),
  analytics: resource({ collection: ["read"] }),
});

const roles = defineRoles({
  owner: { on: "tenant", assignable: true },
  admin: { on: "tenant", assignable: true },
  member: { on: "tenant", assignable: true },
  viewer: { on: "tenant", assignable: true },
});

const plans = definePlans({ free: {}, pro: {} });

export type SaasUser = {
  readonly id: string;
  readonly memberships?: readonly {
    readonly tenant: string;
    readonly roles: readonly string[];
  }[];
};

const readers = [roles.viewer, roles.member, roles.admin, roles.owner];
const writers = [roles.member, roles.admin, roles.owner];
const admins = [roles.admin, roles.owner];

function each(
  list: readonly (typeof roles)[keyof typeof roles][],
  build: (to: (typeof roles)[keyof typeof roles]) => ReturnType<typeof allow>,
): ReturnType<typeof allow>[] {
  return list.map((to) => build(to));
}

export const policy = definePolicy(
  { permissions, roles, plans },
  {
    scopes: { tenant: { key: "orgId" } },
    subject: (user: SaasUser | null) => user,
    grants: [
      ...each(readers, (to) => allow(permissions.project.read, { to })),
      ...each(readers, (to) => allow(permissions.project.list, { to })),
      ...each(writers, (to) => allow(permissions.project.create, { to })),
      allow(permissions.project.update, {
        to: roles.member,
        where: { ownerId: principal.id },
      }),
      allow(permissions.project.delete, {
        to: roles.member,
        where: { ownerId: principal.id },
      }),
      ...each(admins, (to) => allow(permissions.project.update, { to })),
      ...each(admins, (to) => allow(permissions.project.delete, { to })),
      ...each(admins, (to) => allow(permissions.member.list, { to })),
      ...each(admins, (to) => allow(permissions.member.invite, { to })),
      ...each(admins, (to) => allow(permissions.member.assignRole, { to })),
      ...each(admins, (to) => allow(permissions.settings.manage, { to })),
      ...each(admins, (to) =>
        allow(permissions.audit.read, { to: [to, plans.pro] }),
      ),
      ...each(admins, (to) =>
        allow(permissions.analytics.read, { to: [to, plans.pro] }),
      ),
      allow(permissions.billing.read, { to: roles.owner }),
      allow(permissions.billing.manage, { to: roles.owner }),
      deny(permissions.project.delete, {
        to: anyone(),
        where: { archived: true },
      }),
    ],
  },
);

export const alice: SaasUser = {
  id: "alice",
  memberships: [
    { tenant: "acme", roles: ["admin"] },
    { tenant: "globex", roles: ["viewer"] },
  ],
};

export const bob: SaasUser = {
  id: "bob",
  memberships: [{ tenant: "acme", roles: ["member"] }],
};

export const ownProject = {
  id: "p1",
  orgId: "acme",
  ownerId: "bob",
  archived: false,
};

export const otherProject = {
  id: "p2",
  orgId: "acme",
  ownerId: "alice",
  archived: false,
};
