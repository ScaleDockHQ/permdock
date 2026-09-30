import type { StandardSchemaV1 } from '@standard-schema/spec';

import type { Membership, Subject } from '../core/subject.ts';
import type {
  SupabasePrincipal,
  SupabaseSessionLike,
  SupabaseSubjectOptions,
} from './types.ts';

import { compact } from '../core/compact.ts';
import { freezeDeep } from '../core/freeze.ts';
import { anonymousSubject } from '../core/subject.ts';
import { supabaseTenantClaim } from './budget.ts';

const REGISTERED = new Set([
  'sub',
  'role',
  'iss',
  'aud',
  'exp',
  'iat',
  'nbf',
  'aal',
  'amr',
  'acr',
  'session_id',
  'email',
  'phone',
  'is_anonymous',
  'app_metadata',
  'user_metadata',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Top-level first, then `app_metadata`. `null` counts as absent: the RBAC hook writes `null` for a user with no role row. */
function readClaim(claims: Record<string, unknown>, name: string): unknown {
  const top = Object.hasOwn(claims, name) ? claims[name] : undefined;
  if (top !== undefined && top !== null) {
    return top;
  }
  const meta = claims.app_metadata;
  if (isRecord(meta) && Object.hasOwn(meta, name)) {
    return meta[name] ?? undefined;
  }
  return undefined;
}

function asRoles(
  value: unknown,
  declared: readonly string[] | undefined,
): readonly string[] {
  const raw =
    typeof value === 'string'
      ? value === ''
        ? []
        : [value]
      : Array.isArray(value)
        ? value.filter((item): item is string => typeof item === 'string')
        : [];
  if (declared === undefined) {
    return raw;
  }
  const allowed = new Set(declared);
  return raw.filter((role) => allowed.has(role));
}

function asMemberships(value: unknown): readonly Membership[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: Membership[] = [];
  for (const item of value) {
    if (!isRecord(item) || !Array.isArray(item.roles)) {
      continue;
    }
    const roles = item.roles.filter(
      (role): role is string => typeof role === 'string',
    );
    if (roles.length === 0) {
      continue;
    }
    const scope = typeof item.scope === 'string' ? item.scope : undefined;
    const id = typeof item.id === 'string' ? item.id : undefined;
    const within = isRecord(item.within)
      ? Object.fromEntries(
          Object.entries(item.within).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string',
          ),
        )
      : undefined;
    const tenant = typeof item.tenant === 'string' ? item.tenant : undefined;
    const team = typeof item.team === 'string' ? item.team : undefined;
    const onRecord = isRecord(item.on) ? item.on : undefined;
    const on =
      onRecord !== undefined &&
      typeof onRecord.resource === 'string' &&
      typeof onRecord.id === 'string'
        ? { resource: onRecord.resource, id: onRecord.id }
        : undefined;
    if (
      (scope === undefined || id === undefined) &&
      tenant === undefined &&
      team === undefined &&
      on === undefined
    ) {
      continue;
    }
    out.push(
      compact<Membership>({
        roles,
        scope,
        id,
        within,
        tenant,
        team,
        on,
        via: typeof item.via === 'string' ? item.via : undefined,
        expiresAt:
          typeof item.expiresAt === 'number' ? item.expiresAt : undefined,
        managedBy: item.managedBy === 'idp' ? 'idp' : undefined,
        entitlements: Array.isArray(item.entitlements)
          ? item.entitlements.filter(
              (seat): seat is string => typeof seat === 'string',
            )
          : undefined,
      }),
    );
  }
  return out;
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

function extraClaims(claims: Record<string, unknown>): Record<string, unknown> {
  const extra: Record<string, unknown> = {};
  const meta = claims.app_metadata;
  if (isRecord(meta)) {
    for (const [key, value] of Object.entries(meta)) {
      extra[key] = value;
    }
  }
  for (const [key, value] of Object.entries(claims)) {
    if (REGISTERED.has(key) || key === 'user_metadata') {
      continue;
    }
    extra[key] = value;
  }
  return extra;
}

function mapClaims(
  claims: Record<string, unknown>,
  options: SupabaseSubjectOptions,
): Subject<SupabasePrincipal> {
  const role = claims.role;
  if (role === 'anon' || role === 'service_role') {
    return anonymousSubject();
  }
  const id = claims.sub;
  if (typeof id !== 'string' || id === '') {
    return anonymousSubject();
  }
  const roleClaim = options.roles ?? 'user_role';
  const tenantClaim = options.tenant ?? supabaseTenantClaim;
  const membershipsClaim = options.memberships ?? 'memberships';
  let extra = extraClaims(claims);
  if (options.schema !== undefined) {
    extra = validateClaims(extra, options.schema) ?? {};
  }
  const include = new Set(options.include ?? []);
  const tenantValue = readClaim(claims, tenantClaim);
  const version = readClaim(claims, 'authz_ver');
  const principal = compact<SupabasePrincipal>({
    id,
    kind: 'user',
    roles: asRoles(readClaim(claims, roleClaim), options.declared),
    tenant: typeof tenantValue === 'string' ? tenantValue : undefined,
    memberships: asMemberships(readClaim(claims, membershipsClaim)),
    membershipsTruncated:
      readClaim(claims, 'memberships_truncated') === true ? true : undefined,
    authzVersion:
      typeof version === 'number' && Number.isInteger(version)
        ? version
        : undefined,
    issuer: typeof claims.iss === 'string' ? claims.iss : undefined,
    assurance: typeof claims.aal === 'string' ? { acr: claims.aal } : undefined,
    claims: Object.keys(extra).length === 0 ? undefined : extra,
    email:
      include.has('email') && typeof claims.email === 'string'
        ? claims.email
        : undefined,
    phone:
      include.has('phone') && typeof claims.phone === 'string'
        ? claims.phone
        : undefined,
    is_anonymous:
      include.has('is_anonymous') && typeof claims.is_anonymous === 'boolean'
        ? claims.is_anonymous
        : undefined,
  });
  const session =
    typeof claims.session_id === 'string' ? claims.session_id : undefined;
  const expiresAt = typeof claims.exp === 'number' ? claims.exp : undefined;
  return freezeDeep(
    compact<Subject<SupabasePrincipal>>({
      principal,
      context: {},
      session,
      expiresAt,
    }),
  );
}

export function subjectFromSupabase(
  claims: unknown,
  options: SupabaseSubjectOptions = {},
): Subject<SupabasePrincipal> {
  try {
    if (!isRecord(claims)) {
      return anonymousSubject();
    }
    const rest: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(claims)) {
      if (key === 'user_metadata') {
        continue;
      }
      rest[key] = value;
    }
    return mapClaims(rest, options);
  } catch {
    return anonymousSubject();
  }
}

/**
 * A verified session object (for example better-supabase's `AuthSession`) in, `Subject` out.
 * Only `kind: 'user'` sessions map; `anon`, `service`, `invalid` and anything else are anonymous.
 */
export function subjectFromSupabaseSession(
  session: SupabaseSessionLike | null | undefined,
  options: SupabaseSubjectOptions = {},
): Subject<SupabasePrincipal> {
  try {
    if (session === null || session === undefined || session.kind !== 'user') {
      return anonymousSubject();
    }
    return subjectFromSupabase(session.claims, options);
  } catch {
    return anonymousSubject();
  }
}
