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
import { ignoreRejection } from '../core/thenable.ts';

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
    ignoreRejection(result);
    return undefined;
  }
  if ('issues' in result && result.issues !== undefined) {
    return undefined;
  }
  // SAFETY: a synchronous result without issues is the Standard Schema success result, which has value.
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
  'o',
  'v',
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

/**
 * Plan slugs from `pla`, split by owner: `o:` plans belong to the session's
 * organization, everything else (`u:` and unprefixed) to the user.
 */
function planSlugs(pla: unknown): {
  readonly org: readonly string[];
  readonly user: readonly string[];
} {
  const org: string[] = [];
  const user: string[] = [];
  if (typeof pla !== 'string' || pla === '') {
    return { org, user };
  }
  for (const raw of pla.split(',')) {
    const token = raw.trim();
    if (token === '') {
      continue;
    }
    const prefixed = /^([ou]):(.+)$/u.exec(token);
    const slug = prefixed?.[2] ?? token;
    if (slug !== '') {
      (prefixed?.[1] === 'o' ? org : user).push(slug);
    }
  }
  return { org, user };
}

function featureRoles(
  fea: unknown,
  map: Readonly<Record<string, string>> | undefined,
): {
  readonly org: readonly string[];
  readonly user: readonly string[];
  readonly sources: Readonly<Record<string, 'o' | 'u'>>;
} {
  if (map === undefined || typeof fea !== 'string' || fea === '') {
    return { org: [], user: [], sources: {} };
  }
  const org: string[] = [];
  const user: string[] = [];
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
    (source === 'o' ? org : user).push(role);
    if (source !== undefined) {
      sources[role] = source;
    }
  }
  return { org, user, sources };
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

type OrgClaims = {
  readonly tenant: string | undefined;
  readonly orgRole: string | undefined;
  readonly orgPermissions: readonly string[];
};

function splitList(value: unknown): readonly string[] {
  return typeof value === 'string'
    ? value
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item !== '')
    : [];
}

function orgFeatures(fea: unknown): readonly string[] {
  return splitList(fea)
    .map((token) => /^o:(.+)$/u.exec(token)?.[1])
    .filter((feature): feature is string => feature !== undefined);
}

/**
 * Session token v2 carries the organization as `o: { id, rol, per, fpm }`:
 * `fpm` holds one bitmask per `o:` feature in `fea`, bit `i` selecting
 * `per[i]`, so a permission key is `org:<feature>:<per[i]>`.
 */
function orgClaimsV2(claims: Record<string, unknown>): OrgClaims | undefined {
  const org = claims['o'];
  if (!isRecord(org) || typeof org['id'] !== 'string' || org['id'] === '') {
    return undefined;
  }
  const role =
    typeof org['rol'] === 'string' && org['rol'] !== ''
      ? org['rol'].startsWith('org:')
        ? org['rol']
        : `org:${org['rol']}`
      : undefined;
  const actions = splitList(org['per']);
  const features = orgFeatures(claims['fea']);
  const masks = splitList(org['fpm']).map(Number);
  const orgPermissions: string[] = [];
  for (const [index, feature] of features.entries()) {
    const mask = masks[index];
    if (mask === undefined || !Number.isSafeInteger(mask) || mask < 0) {
      continue;
    }
    for (const [bit, action] of actions.entries()) {
      if (bit < 31 && (mask & (1 << bit)) !== 0) {
        orgPermissions.push(`org:${feature}:${action}`);
      }
    }
  }
  return { tenant: org['id'], orgRole: role, orgPermissions };
}

function orgClaimsV1(claims: Record<string, unknown>): OrgClaims {
  return {
    tenant: typeof claims['org_id'] === 'string' ? claims['org_id'] : undefined,
    orgRole:
      typeof claims['org_role'] === 'string' ? claims['org_role'] : undefined,
    orgPermissions: asRoles(claims['org_permissions']),
  };
}

function orgClaims(claims: Record<string, unknown>): OrgClaims {
  return orgClaimsV2(claims) ?? orgClaimsV1(claims);
}

function isAuthObject(value: unknown): value is ClerkAuthObject {
  if (!isRecord(value)) {
    return false;
  }
  return typeof value['has'] === 'function' || isRecord(value['sessionClaims']);
}

function isVerifiedPayload(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false;
  }
  if (typeof value['sub'] !== 'string' || value['sub'] === '') {
    return false;
  }
  return (
    typeof value['sid'] === 'string' ||
    typeof value['azp'] === 'string' ||
    typeof value['org_id'] === 'string' ||
    orgClaimsV2(value) !== undefined
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
  const fromClaims = orgClaims(claims);
  const id =
    typeof auth.userId === 'string'
      ? auth.userId
      : typeof claims['sub'] === 'string'
        ? claims['sub']
        : undefined;
  const tenant =
    typeof auth.orgId === 'string' ? auth.orgId : fromClaims.tenant;
  const orgRole =
    typeof auth.orgRole === 'string' ? auth.orgRole : fromClaims.orgRole;
  const orgPermissions =
    auth.orgPermissions !== undefined && auth.orgPermissions !== null
      ? asRoles(auth.orgPermissions)
      : fromClaims.orgPermissions;
  const session =
    typeof auth.sessionId === 'string'
      ? auth.sessionId
      : typeof claims['sid'] === 'string'
        ? claims['sid']
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
    id: typeof claims['sub'] === 'string' ? claims['sub'] : undefined,
    ...orgClaims(claims),
    claims,
    session: typeof claims['sid'] === 'string' ? claims['sid'] : undefined,
  };
}

const MEMBERSHIP_PAGE = 100;
const MEMBERSHIP_PAGES = 50;

function membershipRow(item: unknown, userId: string): Membership | undefined {
  if (!isRecord(item)) {
    return undefined;
  }
  const owner = isRecord(item['publicUserData'])
    ? item['publicUserData']['userId']
    : undefined;
  if (typeof owner === 'string' && owner !== userId) {
    return undefined;
  }
  const organization = isRecord(item['organization'])
    ? item['organization']
    : undefined;
  const tenant =
    typeof item['organizationId'] === 'string'
      ? item['organizationId']
      : typeof organization?.['id'] === 'string'
        ? organization['id']
        : undefined;
  const roles = asRoles(item['role']);
  if (tenant === undefined || roles.length === 0) {
    return undefined;
  }
  return compact<Membership>({ tenant, roles });
}

async function extraMemberships(
  backend: ClerkBackend | undefined,
  userId: string,
): Promise<readonly Membership[]> {
  const list = backend?.users?.getOrganizationMembershipList;
  if (list === undefined) {
    return [];
  }
  try {
    const out: Membership[] = [];
    for (let page = 0; page < MEMBERSHIP_PAGES; page += 1) {
      const offset = page * MEMBERSHIP_PAGE;
      // oxlint-disable-next-line no-await-in-loop -- each page's offset depends on the previous page's size
      const raw = await list({ userId, limit: MEMBERSHIP_PAGE, offset });
      const rows = Array.isArray(raw)
        ? raw
        : isRecord(raw) && Array.isArray(raw.data)
          ? raw.data
          : [];
      for (const item of rows) {
        const row = membershipRow(item, userId);
        if (row !== undefined) {
          out.push(row);
        }
      }
      const total =
        isRecord(raw) && typeof raw.totalCount === 'number'
          ? raw.totalCount
          : undefined;
      if (
        rows.length < MEMBERSHIP_PAGE ||
        (total !== undefined && offset + rows.length >= total)
      ) {
        break;
      }
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
    // SAFETY: not an auth object, so isVerifiedPayload above confirmed a verified payload record.
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
    const features = featureRoles(mapped.claims['fea'], options.features);
    const plans = planSlugs(mapped.claims['pla']);
    const membershipRoles = [
      ...(orgRole === undefined ? [] : [orgRole]),
      ...permissionRoles,
      ...features.org,
    ];
    const sessionMembership =
      mapped.tenant !== undefined &&
      (membershipRoles.length > 0 || plans.org.length > 0)
        ? [
            compact<Membership>({
              tenant: mapped.tenant,
              roles: membershipRoles,
              entitlements: plans.org.length === 0 ? undefined : plans.org,
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
    const global = [
      ...globalRolesFrom(mapped.claims, options.globalRoles),
      ...features.user,
    ];
    const exp = mapped.claims['exp'];
    const principal = compact<ClerkPrincipal>({
      id: mapped.id,
      kind: 'user',
      tenant: mapped.tenant,
      roles: global,
      plans: plans.user.length === 0 ? undefined : plans.user,
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
