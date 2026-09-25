import type { Membership, Principal, Subject } from 'permdock';

import { allow, anyone, definePolicy, deny, principal } from 'permdock';

import { permissions, plans, roles } from './permissions.ts';

type RoleRef = (typeof roles)[keyof typeof roles];
type Grant = ReturnType<typeof allow>;

const readers: readonly RoleRef[] = [
  roles.viewer,
  roles.member,
  roles.admin,
  roles.owner,
];
const writers: readonly RoleRef[] = [roles.member, roles.admin, roles.owner];
const admins: readonly RoleRef[] = [roles.admin, roles.owner];

function each(
  list: readonly RoleRef[],
  build: (to: RoleRef) => Grant,
): Grant[] {
  return list.map((to) => build(to));
}

export const policy = definePolicy(
  { permissions, roles, plans },
  {
    scopes: { tenant: { key: 'orgId' } },
    subject: (user: Principal | null) => user,
    grants: [
      ...each(readers, (to) => allow(permissions.project.read, { to })),
      ...each(readers, (to) => allow(permissions.project.list, { to })),
      ...each(readers, (to) => allow(permissions.integration.read, { to })),
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
      ...each(admins, (to) => allow(permissions.apiKey.manage, { to })),
      ...each(admins, (to) =>
        allow(permissions.analytics.read, { to: [to, plans.pro] }),
      ),
      ...each(admins, (to) =>
        allow(permissions.audit.read, { to: [to, plans.pro] }),
      ),
      ...each(admins, (to) =>
        allow(permissions.sso.manage, { to: [to, plans.pro] }),
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

export type SessionClaims = {
  readonly sub: string;
  readonly exp: number;
  readonly iat: number;
  readonly memberships?: readonly Membership[];
};

/**
 * The verified claims as a PermDock subject. `memberships` replaces the
 * claim in database mode; `plans` are the active tenant's plans.
 */
export function subjectOf(
  claims: SessionClaims | null,
  options: {
    readonly memberships?: readonly Membership[];
    readonly plans?: readonly string[];
  } = {},
): Subject | null {
  if (claims === null) {
    return null;
  }
  return {
    principal: {
      id: claims.sub,
      memberships: [...(options.memberships ?? claims.memberships ?? [])],
      plans: [...(options.plans ?? [])],
    },
    context: {},
    expiresAt: claims.exp,
  };
}
