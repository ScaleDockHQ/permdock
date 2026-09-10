import type { StandardSchemaV1 } from '@standard-schema/spec';

import type { Membership, Subject } from '../core/subject.ts';
import type {
  ClerkAuthObject,
  ClerkBackend,
  ClerkGlobalRoles,
  ClerkPrincipal,
  ClerkSubjectOptions,
} from './types.ts';

import { compact } from '../core/compact.ts';
import { freezeDeep } from '../core/freeze.ts';
import { anonymousSubject } from '../core/subject.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asRoles(value: unknown): readonly string[] {
  if (typeof value === 'string') {
    return value === '' ? [] : [value];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string');
}

function readPath(record: Record<string, unknown>, path: string): unknown {
  let current: unknown = record;
  for (const part of path.split('.')) {
    if (!isRecord(current) || !Object.hasOwn(current, part)) {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

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

const REGISTERED_CLAIMS = new Set([
  'iss',
  'sub',
  'aud',
  'exp',
  'nbf',
  'iat',
  'jti',
  'sid',
  'org_id',
  'org_role',
  'org_permissions',
  'org_slug',
  'pla',
  'fea',
]);

function extraClaims(claims: Record<string, unknown>): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(claims)) {
    if (REGISTERED_CLAIMS.has(key) || key === 'unsafeMetadata') {
      continue;
    }
    extra[key] = value;
  }
  return extra;
}

function planSlugs(pla: unknown): readonly string[] {
  if (typeof pla !== 'string' || pla === '') {
    return [];
  }
  const plans: string[] = [];
  for (const raw of pla.split(',')) {
    const token = raw.trim();
    if (token === '') {
      continue;
    }
    const prefixed = /^([ou]):(.+)$/u.exec(token);
    const slug = prefixed?.[2] ?? token;
    if (slug !== '') {
      plans.push(slug);
    }
  }
  return plans;
}

function featureRoles(
  fea: unknown,
  map: Readonly<Record<string, string>> | undefined,
): {
  readonly roles: readonly string[];
  readonly sources: Readonly<Record<string, 'o' | 'u'>>;
} {
  if (map === undefined || typeof fea !== 'string' || fea === '') {
    return { roles: [], sources: {} };
  }
  const roles: string[] = [];
  const sources: Record<string, 'o' | 'u'> = {};
  for (const raw of fea.split(',')) {
    const token = raw.trim();
    if (token === '') {
      continue;
    }
    const prefixed = /^([ou]):(.+)$/u.exec(token);
    const slug = prefixed?.[2] ?? token;
    const source =
      prefixed?.[1] === 'o' || prefixed?.[1] === 'u' ? prefixed[1] : undefined;
    const role = map[slug];
    if (role === undefined) {
      continue;
    }
    roles.push(role);
    if (source !== undefined) {
      sources[role] = source;
    }
  }
  return { roles, sources };
}

function globalRolesFrom(
  claims: Record<string, unknown>,
  option: ClerkGlobalRoles | undefined,
): readonly string[] {
  if (option === undefined) {
    return [];
  }
  if (typeof option === 'function') {
    try {
      return asRoles(option(claims));
    } catch {
      return [];
    }
  }
  return asRoles(readPath(claims, option));
}

function isAuthObject(value: unknown): value is ClerkAuthObject {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value.has === 'function' || isRecord(value.sessionClaims);
}

function isVerifiedPayload(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false;
  }
  if (typeof value.sub !== 'string' || value.sub === '') {
    return false;
  }
  return (
    typeof value.sid === 'string' ||
    typeof value.azp === 'string' ||
    typeof value.org_id === 'string'
  );
}

function fromAuthObject(auth: ClerkAuthObject): {
  readonly id: string | undefined;
  readonly tenant: string | undefined;
  readonly orgRole: string | undefined;
  readonly orgPermissions: readonly string[];
  readonly claims: Record<string, unknown>;
  readonly session: string | undefined;
} {
  const claims = isRecord(auth.sessionClaims) ? { ...auth.sessionClaims } : {};
  const id =
    typeof auth.userId === 'string'
      ? auth.userId
      : typeof claims.sub === 'string'
        ? claims.sub
        : undefined;
  const tenant =
    typeof auth.orgId === 'string'
      ? auth.orgId
      : typeof claims.org_id === 'string'
        ? claims.org_id
        : undefined;
  const orgRole =
    typeof auth.orgRole === 'string'
      ? auth.orgRole
      : typeof claims.org_role === 'string'
        ? claims.org_role
        : undefined;
  const orgPermissions =
    auth.orgPermissions !== undefined && auth.orgPermissions !== null
      ? asRoles(auth.orgPermissions)
      : asRoles(claims.org_permissions);
  const session =
    typeof auth.sessionId === 'string'
      ? auth.sessionId
      : typeof claims.sid === 'string'
        ? claims.sid
        : undefined;
  return { id, tenant, orgRole, orgPermissions, claims, session };
}

function fromPayload(claims: Record<string, unknown>): {
  readonly id: string | undefined;
  readonly tenant: string | undefined;
  readonly orgRole: string | undefined;
  readonly orgPermissions: readonly string[];
  readonly claims: Record<string, unknown>;
  readonly session: string | undefined;
} {
  return {
    id: typeof claims.sub === 'string' ? claims.sub : undefined,
    tenant: typeof claims.org_id === 'string' ? claims.org_id : undefined,
    orgRole: typeof claims.org_role === 'string' ? claims.org_role : undefined,
    orgPermissions: asRoles(claims.org_permissions),
    claims,
    session: typeof claims.sid === 'string' ? claims.sid : undefined,
  };
}

async function extraMemberships(
  backend: ClerkBackend | undefined,
  userId: string,
): Promise<readonly Membership[]> {
  try {
    const raw = await backend?.users?.getOrganizationMembershipList?.({
      userId,
    });
    const rows = Array.isArray(raw)
      ? raw
      : isRecord(raw) && Array.isArray(raw.data)
        ? raw.data
        : [];
    const out: Membership[] = [];
    for (const item of rows) {
      if (!isRecord(item)) {
        continue;
      }
      const organization = isRecord(item.organization)
        ? item.organization
        : undefined;
      const tenant =
        typeof item.organizationId === 'string'
          ? item.organizationId
          : typeof organization?.id === 'string'
            ? organization.id
            : undefined;
      const roles = asRoles(item.role);
      if (tenant === undefined || roles.length === 0) {
        continue;
      }
      out.push(compact<Membership>({ tenant, roles }));
    }
    return out;
  } catch {
    return [];
  }
}

export async function subjectFromClerk(
  authObject: unknown,
  options: ClerkSubjectOptions = {},
): Promise<Subject<ClerkPrincipal>> {
  try {
    const trustedObject = isAuthObject(authObject);
    const trustedPayload = isVerifiedPayload(authObject);
    if (!trustedObject && !trustedPayload) {
      return anonymousSubject();
    }
    const mapped = trustedObject
      ? fromAuthObject(authObject)
      : fromPayload(authObject as Record<string, unknown>);
    if (mapped.id === undefined || mapped.id === '') {
      return anonymousSubject();
    }
    const declared = options.declared;
    const orgRole =
      mapped.orgRole !== undefined &&
      (declared === undefined || declared.includes(mapped.orgRole))
        ? mapped.orgRole
        : undefined;
    const permissionRoles = Object.keys(options.permissions ?? {}).filter(
      (key) => mapped.orgPermissions.includes(key),
    );
    const membershipRoles = [
      ...(orgRole === undefined ? [] : [orgRole]),
      ...permissionRoles,
    ];
    const sessionMembership =
      mapped.tenant !== undefined && membershipRoles.length > 0
        ? [
            compact<Membership>({
              tenant: mapped.tenant,
              roles: membershipRoles,
            }),
          ]
        : [];
    const loaded =
      options.memberships === 'all'
        ? await extraMemberships(options.backend, mapped.id)
        : [];
    const seen = new Set(sessionMembership.map((item) => item.tenant));
    const memberships = [
      ...sessionMembership,
      ...loaded.filter((item) => {
        if (seen.has(item.tenant)) {
          return false;
        }
        seen.add(item.tenant);
        return true;
      }),
    ];
    let claims = extraClaims(mapped.claims);
    if (options.schema !== undefined) {
      claims = validateClaims(claims, options.schema) ?? {};
    }
    const features = featureRoles(mapped.claims.fea, options.features);
    const global = [
      ...globalRolesFrom(mapped.claims, options.globalRoles),
      ...features.roles,
    ];
    const exp = mapped.claims.exp;
    const principal = compact<ClerkPrincipal>({
      id: mapped.id,
      kind: 'user',
      tenant: mapped.tenant,
      roles: global,
      plans:
        planSlugs(mapped.claims.pla).length === 0
          ? undefined
          : planSlugs(mapped.claims.pla),
      memberships,
      clerkPermissions: mapped.orgPermissions,
      claims: Object.keys(claims).length === 0 ? undefined : claims,
      featureSources:
        Object.keys(features.sources).length === 0
          ? undefined
          : features.sources,
    });
    return freezeDeep(
      compact<Subject<ClerkPrincipal>>({
        principal,
        context: {},
        session: mapped.session,
        expiresAt: typeof exp === 'number' ? exp : undefined,
      }),
    );
  } catch {
    return anonymousSubject();
  }
}
