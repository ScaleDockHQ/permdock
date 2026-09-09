import type { StandardSchemaV1 } from '@standard-schema/spec';

import type { Membership, Subject } from '../core/subject.ts';
import type {
  BetterAuthLike,
  BetterAuthPrincipal,
  BetterAuthSubjectOptions,
} from './types.ts';

import { compact } from '../core/compact.ts';
import { freezeDeep } from '../core/freeze.ts';
import { anonymousSubject } from '../core/subject.ts';
import {
  asRoles,
  expiresAtSeconds,
  isRecord,
  parseMemberRows,
  parseTeamRows,
} from './parse.ts';

const PROFILE_FIELDS = new Set(['name', 'image', 'displayName']);

function validateClaims(
  extra: Record<string, unknown>,
  schema: StandardSchemaV1,
): Record<string, unknown> | undefined {
  const result = schema['~standard'].validate(extra);
  if (result instanceof Promise) {
    return undefined;
  }
  if ('issues' in result && result.issues !== undefined) {
    return undefined;
  }
  const value = (result as { readonly value: unknown }).value;
  return isRecord(value) ? value : undefined;
}

function extraFields(user: Record<string, unknown>): Record<string, unknown> {
  const reserved = new Set([
    'id',
    'role',
    'roles',
    'email',
    'emailVerified',
    'createdAt',
    'updatedAt',
    'banned',
    'banReason',
    'banExpires',
  ]);
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(user)) {
    if (reserved.has(key) || PROFILE_FIELDS.has(key)) {
      continue;
    }
    extra[key] = value;
  }
  return extra;
}

function isTrustedSession(
  session: unknown,
): session is Record<string, unknown> {
  if (!isRecord(session)) {
    return false;
  }
  return isRecord(session.user) || isRecord(session.session);
}

async function loadMemberships(
  auth: BetterAuthLike,
  session: Record<string, unknown>,
  user: Record<string, unknown>,
  tenant: string | undefined,
  options: BetterAuthSubjectOptions,
): Promise<readonly Membership[]> {
  const injectedMembers = parseMemberRows(
    session.members ?? session.member ?? user.members,
  );
  const injectedTeams = parseTeamRows(
    session.teamMembers ?? session.teams ?? user.teamMembers,
  );
  let members = injectedMembers;
  let teams = injectedTeams;
  const headers = options.headers;
  if (members.length === 0 && auth.api?.listOrganizations !== undefined) {
    try {
      members = parseMemberRows(await auth.api.listOrganizations({ headers }));
    } catch {
      members = [];
    }
  }
  if (members.length === 0 && auth.api?.listMembers !== undefined) {
    try {
      members = parseMemberRows(
        await auth.api.listMembers({
          query: compact({ organizationId: tenant }),
          headers,
        }),
      );
    } catch {
      members = [];
    }
  }
  if (teams.length === 0 && auth.api?.listTeams !== undefined) {
    try {
      teams = parseTeamRows(
        await auth.api.listTeams({
          query: compact({ organizationId: tenant }),
          headers,
        }),
      );
    } catch {
      teams = [];
    }
  }
  if (options.memberships === 'active' && tenant !== undefined) {
    members = members.filter((item) => item.tenant === tenant);
    teams = teams.filter((item) => item.tenant === tenant);
  }
  return [...members, ...teams];
}

export async function subjectFromBetterAuth(
  auth: BetterAuthLike,
  session: unknown,
  options: BetterAuthSubjectOptions = {},
): Promise<Subject<BetterAuthPrincipal>> {
  try {
    if (
      session === null ||
      session === undefined ||
      !isTrustedSession(session)
    ) {
      return anonymousSubject();
    }
    if (!isRecord(session.user)) {
      return anonymousSubject();
    }
    const user = session.user;
    const record = isRecord(session.session) ? session.session : undefined;
    const id = typeof user.id === 'string' ? user.id : undefined;
    if (id === undefined || id === '') {
      return anonymousSubject();
    }
    const tenant =
      typeof record?.activeOrganizationId === 'string'
        ? record.activeOrganizationId
        : undefined;
    const roles = asRoles(user.role ?? user.roles);
    const declared = options.declared;
    const globalRoles =
      declared === undefined
        ? roles
        : roles.filter((role) => declared.includes(role));
    let extra = extraFields(user);
    if (options.schema !== undefined) {
      extra = validateClaims(extra, options.schema) ?? {};
    }
    const memberships = await loadMemberships(
      auth,
      session,
      user,
      tenant,
      options,
    );
    const principal = compact<BetterAuthPrincipal>({
      id,
      kind: 'user',
      roles: globalRoles,
      tenant,
      memberships,
      email: typeof user.email === 'string' ? user.email : undefined,
      claims: Object.keys(extra).length === 0 ? undefined : extra,
    });
    return freezeDeep(
      compact<Subject<BetterAuthPrincipal>>({
        principal,
        context: {},
        session: typeof record?.id === 'string' ? record.id : undefined,
        expiresAt: expiresAtSeconds(record?.expiresAt),
      }),
    );
  } catch {
    return anonymousSubject();
  }
}
