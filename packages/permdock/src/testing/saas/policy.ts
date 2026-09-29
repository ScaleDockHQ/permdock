import type { Policy, Principal, Subject } from '../../index.ts';
import type { SaasDoc } from './permissions.ts';

import {
  allow,
  anyone,
  definePolicy,
  deny,
  principal,
  relation,
  role,
} from '../../index.ts';
import { saasPermissions, saasPlans, saasRoles } from './permissions.ts';

function isSubject(user: Principal | Subject | null): user is Subject {
  return user !== null && 'context' in user && 'principal' in user;
}

type RoleRef = (typeof saasRoles)[keyof typeof saasRoles];
type Grant = ReturnType<typeof allow>;

const p = saasPermissions;
const r = saasRoles;

const readers: readonly RoleRef[] = [r.viewer, r.member, r.admin, r.owner];
const writers: readonly RoleRef[] = [r.member, r.admin, r.owner];
const admins: readonly RoleRef[] = [r.admin, r.owner];

function each(
  list: readonly RoleRef[],
  build: (to: RoleRef) => Grant,
): Grant[] {
  return list.map((to) => build(to));
}

/** Daily API-key quota per subject; the bucket should be per tenant too. */
export const SAAS_API_KEY_LIMIT = 5;

/**
 * The shared multi-tenant SaaS policy: four tenant roles, a team role, a
 * resource-scoped role, plan-gated features, a closure deny, a quota, an
 * approval and a folder tree shared through edges. Row conditions and
 * relations are portable; the closure is not, and the folder grants need
 * a `RelationSource` (`saasRelations()`).
 */
type SaasVocabulary = {
  readonly permissions: typeof saasPermissions;
  readonly roles: typeof saasRoles;
  readonly plans: typeof saasPlans;
};

export const saasPolicy: Policy<
  Principal | Subject | null,
  Principal,
  SaasVocabulary
> = definePolicy(
  { permissions: saasPermissions, roles: saasRoles, plans: saasPlans },
  {
    scopes: {
      tenant: { key: 'orgId' },
      team: { key: 'teamId', within: 'tenant' },
    },
    // A full `Subject` (with `expiresAt` or `session`) is used as is.
    subject: (user: Principal | Subject | null): Principal | null =>
      isSubject(user) ? user.principal : user,
    roles: [
      role(r.lead, [
        allow(p.doc.update, { to: r.lead }),
        deny(p.doc.update, (doc: SaasDoc) => doc.locked),
      ]),
      role(r.collaborator, [allow(p.project.update, { to: r.collaborator })], {
        on: p.project,
      }),
    ],
    grants: [
      ...each(readers, (to) => allow(p.project.read, { to })),
      ...each(readers, (to) => allow(p.project.list, { to })),
      ...each(readers, (to) => allow(p.integration.read, { to })),
      ...each(writers, (to) => allow(p.project.create, { to })),
      allow(p.project.update, {
        to: r.member,
        where: { ownerId: principal.id },
      }),
      allow(p.project.delete, {
        to: r.member,
        where: { ownerId: principal.id },
      }),
      ...each(admins, (to) => allow(p.project.update, { to })),
      ...each(admins, (to) => allow(p.project.delete, { to })),
      ...each(admins, (to) => allow(p.member.list, { to })),
      ...each(admins, (to) => allow(p.member.invite, { to })),
      ...each(admins, (to) => allow(p.member.assignRole, { to })),
      ...each(admins, (to) => allow(p.settings.manage, { to })),
      ...each(admins, (to) => allow(p.apiKey.manage, { to })),
      ...each(admins, (to) =>
        allow(p.apiKey.create, {
          to,
          limit: { count: SAAS_API_KEY_LIMIT, per: 'day' },
        }),
      ),
      allow(p.apiKey.revokeAll, {
        to: r.admin,
        approval: { by: r.owner, distinct: true },
      }),
      allow(p.apiKey.revokeAll, { to: r.owner }),
      ...each(admins, (to) =>
        allow(p.analytics.read, { to: [to, saasPlans.pro] }),
      ),
      ...each(admins, (to) => allow(p.audit.read, { to: [to, saasPlans.pro] })),
      ...each(admins, (to) => allow(p.sso.manage, { to: [to, saasPlans.pro] })),
      allow(p.billing.read, { to: r.owner }),
      allow(p.billing.manage, { to: r.owner }),
      deny(p.project.delete, { to: anyone(), where: { archived: true } }),
      ...each(readers, (to) => allow(p.doc.read, { to })),
      allow(p.doc.update, { to: relation(p.doc, 'team') }),
      ...each(admins, (to) => allow(p.folder.read, { to })),
      allow(p.folder.read, {
        to: relation(p.folder, 'viewer', { through: 'parent', depth: 8 }),
      }),
      allow(p.folder.update, {
        to: relation(p.folder, 'editor', { through: 'parent', depth: 8 }),
      }),
    ],
  },
);
