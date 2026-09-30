import type { StandardSchemaV1 } from '@standard-schema/spec';

import type { Membership, Subject } from '../core/subject.ts';
import type {
  BetterAuthLike,
  BetterAuthPrincipal,
  BetterAuthSubjectOptions,
} from './types.ts';

import { compact } from '../core/compact.ts';
import { freezeDeep } from '../core/freeze.ts';
import { isReadonlyArray } from '../core/lists.ts';
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

async function settle<T>(load: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await load();
  } catch {
    return fallback;
  }
}

async function organizationIds(
  auth: BetterAuthLike,
  tenant: string | undefined,
  options: BetterAuthSubjectOptions,
): Promise<readonly string[]> {
  const list = auth.api?.listOrganizations;
  if (options.memberships === 'active' || list === undefined) {
    return tenant === undefined ? [] : [tenant];
  }
  const rows = await settle(async () => {
    const value: unknown = await list({ headers: options.headers });
    return isReadonlyArray(value) ? value : [];
  }, []);
  const ids = rows
    .map((row: unknown) =>
      isRecord(row) && typeof row.id === 'string' ? row.id : undefined,
    )
    .filter((id): id is string => id !== undefined && id !== '');
  return [...new Set(ids)];
}

function memberIn(
  auth: BetterAuthLike,
  userId: string,
  organizationId: string,
  tenant: string | undefined,
  headers: unknown,
): Promise<readonly Membership[]> {
  const active = auth.api?.getActiveMember;
  if (organizationId === tenant && active !== undefined) {
    return settle(
      async () => parseMemberRows(await active({ headers }), userId),
      [],
    );
  }
  const list = auth.api?.listMembers;
  if (list === undefined) {
    return Promise.resolve([]);
  }
  return settle(
    async () =>
      parseMemberRows(
        await list({
          query: {
            organizationId,
            filterField: 'userId',
            filterOperator: 'eq',
            filterValue: userId,
          },
          headers,
        }),
        userId,
      ).filter((item) => item.tenant === organizationId),
    [],
  );
}

async function loadMemberships(
  auth: BetterAuthLike,
  session: Record<string, unknown>,
  user: Record<string, unknown>,
  userId: string,
  tenant: string | undefined,
  options: BetterAuthSubjectOptions,
): Promise<readonly Membership[]> {
  let members = parseMemberRows(
    session.members ?? session.member ?? user.members,
    userId,
    false,
  );
  let teams = parseTeamRows(
    session.teamMembers ?? session.teams ?? user.teamMembers,
    userId,
  );
  const headers = options.headers;
  if (members.length === 0) {
    const ids = await organizationIds(auth, tenant, options);
    const found = await Promise.all(
      ids.map((id) => memberIn(auth, userId, id, tenant, headers)),
    );
    members = found.flat();
  }
  const listUserTeams = auth.api?.listUserTeams;
  if (teams.length === 0 && listUserTeams !== undefined) {
    teams = await settle(
      async () => parseTeamRows(await listUserTeams({ headers }), userId),
      [],
    );
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
      id,
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
