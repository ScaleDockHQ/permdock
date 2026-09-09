import type { StandardSchemaV1 } from '@standard-schema/spec';

import type { JwtClaims } from '../core/interfaces.ts';
import type {
  Actor,
  Assurance,
  AuthorizationDetail,
  Binding,
  Delegation,
  GnapAccess,
  Membership,
  Principal,
} from '../core/subject.ts';
import type {
  JwtClaimPaths,
  JwtPrincipal,
  JwtSubjectOptions,
} from './types.ts';

import { compact } from '../core/compact.ts';
import { freezeDeep } from '../core/freeze.ts';
import { readPath } from '../core/paths.ts';
import { anonymousSubject } from '../core/subject.ts';

const DEFAULT_CLAIMS = {
  id: 'sub',
  roles: 'roles',
  groups: 'groups',
  entitlements: 'entitlements',
  session: 'sid',
} as const;

function asStringArray(value: unknown): string[] {
  if (typeof value === 'string') {
    return value.length === 0 ? [] : value.split(/[,\s]+/u).filter(Boolean);
  }
  if (!Array.isArray(value)) {
    return [];
  }
  const out: string[] = [];
  for (const item of value) {
    if (typeof item === 'string') {
      out.push(item);
      continue;
    }
    if (
      item !== null &&
      typeof item === 'object' &&
      'value' in item &&
      typeof (item as { readonly value?: unknown }).value === 'string'
    ) {
      out.push((item as { readonly value: string }).value);
    }
  }
  return out;
}

function kindOf(
  claims: JwtClaims,
  paths: JwtClaimPaths | undefined,
): Principal['kind'] {
  const kind = paths?.kind;
  if (kind === 'workload' || kind === 'user' || kind === 'service') {
    return kind;
  }
  if (kind !== undefined) {
    const value = readPath(claims, kind);
    if (value === 'workload' || value === 'user' || value === 'service') {
      return value;
    }
  }
  return undefined;
}

function assuranceOf(
  claims: JwtClaims,
  paths: JwtClaimPaths | undefined,
): Assurance | undefined {
  const configured = paths?.assurance;
  const acrPath =
    typeof configured === 'string' ? configured : (configured?.acr ?? 'acr');
  const amrPath =
    typeof configured === 'string' ? 'amr' : (configured?.amr ?? 'amr');
  const authTimePath =
    typeof configured === 'string'
      ? 'auth_time'
      : (configured?.authTime ?? 'auth_time');
  const acr = readPath(claims, acrPath);
  const amr = readPath(claims, amrPath);
  const authTime = readPath(claims, authTimePath);
  const assurance = compact<Assurance>({
    acr: typeof acr === 'string' ? acr : undefined,
    amr: Array.isArray(amr)
      ? amr.filter((item): item is string => typeof item === 'string')
      : undefined,
    authTime: typeof authTime === 'number' ? authTime : undefined,
  });
  return Object.keys(assurance).length === 0 ? undefined : assurance;
}

function bindingOf(claims: JwtClaims): Binding | undefined {
  const cnf = claims.cnf;
  if (cnf === null || typeof cnf !== 'object' || Array.isArray(cnf)) {
    return undefined;
  }
  const record = cnf as Record<string, unknown>;
  const binding = compact<Binding>({
    jkt: typeof record.jkt === 'string' ? record.jkt : undefined,
    'x5t#S256':
      typeof record['x5t#S256'] === 'string' ? record['x5t#S256'] : undefined,
    jwk:
      record.jwk !== null && typeof record.jwk === 'object'
        ? (record.jwk as Binding['jwk'])
        : undefined,
    kid: typeof record.kid === 'string' ? record.kid : undefined,
  });
  return Object.keys(binding).length === 0 ? undefined : binding;
}

function membershipsFromGroups(
  groups: readonly string[],
  groupRoles: Readonly<Record<string, readonly string[]>> | undefined,
  tenant: string | undefined,
): Membership[] {
  return groups.map((team) =>
    compact<Membership>({
      tenant,
      team,
      roles: groupRoles?.[team] ?? [],
      via: `group:${team}`,
    }),
  );
}

function membershipsFromClaim(value: unknown): Membership[] {
  if (Array.isArray(value)) {
    return value.flatMap((item) => membershipsFromClaim(item));
  }
  if (value === null || typeof value !== 'object') {
    return [];
  }
  const record = value as Record<string, unknown>;
  if (typeof record.tenant === 'string' || typeof record.org_id === 'string') {
    return [
      compact<Membership>({
        tenant:
          typeof record.tenant === 'string'
            ? record.tenant
            : String(record.org_id),
        roles: asStringArray(record.roles),
        team: typeof record.team === 'string' ? record.team : undefined,
      }),
    ];
  }
  const out: Membership[] = [];
  for (const [tenant, entry] of Object.entries(record)) {
    if (Array.isArray(entry)) {
      out.push(compact<Membership>({ tenant, roles: asStringArray(entry) }));
      continue;
    }
    if (entry !== null && typeof entry === 'object') {
      const nested = entry as Record<string, unknown>;
      out.push(
        compact<Membership>({
          tenant,
          roles: asStringArray(nested.roles ?? nested),
        }),
      );
    }
  }
  return out;
}

type ActorFromAct =
  | { readonly status: 'ok'; readonly actor: Actor; readonly chain: unknown }
  | { readonly status: 'invalid' }
  | { readonly status: 'absent' };

function isActObject(
  value: unknown,
): value is { readonly sub?: unknown; readonly act?: unknown } {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function actorFromAct(
  claims: JwtClaims,
  options: JwtSubjectOptions,
): ActorFromAct {
  const configured = options.actor;
  if (typeof configured === 'function') {
    const actor = configured(claims);
    return actor === undefined
      ? { status: 'absent' }
      : { status: 'ok', actor, chain: claims.act };
  }
  if (configured !== undefined && configured.from !== 'act') {
    return { status: 'absent' };
  }
  if (!Object.hasOwn(claims, 'act') || claims.act === undefined) {
    return { status: 'absent' };
  }
  const act = claims.act;
  if (!isActObject(act)) {
    return { status: 'invalid' };
  }
  let current: unknown = act;
  let innermost = act;
  while (isActObject(current) && Object.hasOwn(current, 'act')) {
    current = current.act;
    if (!isActObject(current)) {
      return { status: 'invalid' };
    }
    innermost = current;
  }
  if (typeof innermost.sub !== 'string' || innermost.sub.length === 0) {
    return { status: 'invalid' };
  }
  return {
    status: 'ok',
    actor: compact<Actor>({
      id: innermost.sub,
      kind: configured?.kind ?? 'oauth-client',
    }),
    chain: act,
  };
}

function delegationOf(
  claims: JwtClaims,
  options: JwtSubjectOptions,
  chain: unknown,
): Delegation | undefined {
  const paths = options.delegation;
  const scopes = asStringArray(readPath(claims, paths?.scopes ?? 'scope'));
  const details = readPath(
    claims,
    paths?.authorizationDetails ?? 'authorization_details',
  );
  const access = readPath(claims, paths?.access ?? 'access');
  const authorizationDetails = Array.isArray(details)
    ? (details as AuthorizationDetail[])
    : undefined;
  const accessList = Array.isArray(access)
    ? (access as GnapAccess[])
    : undefined;
  const delegation = compact<Delegation>({
    scopes: scopes.length > 0 ? scopes : undefined,
    authorizationDetails,
    access: accessList,
    chain,
  });
  return Object.keys(delegation).length === 0 ? undefined : delegation;
}

function customClaims(
  claims: JwtClaims,
  reserved: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(claims)) {
    if (reserved.includes(key)) {
      continue;
    }
    out[key] = value;
  }
  return out;
}

export function validateCustomClaims(
  claims: Record<string, unknown>,
  schema: StandardSchemaV1,
):
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false } {
  const result = schema['~standard'].validate(claims);
  if (result instanceof Promise) {
    return { ok: false };
  }
  if ('issues' in result && result.issues !== undefined) {
    return { ok: false };
  }
  return {
    ok: true,
    value: (result as { readonly value: Record<string, unknown> }).value,
  };
}

export function mapClaimsToSubject(
  claims: JwtClaims,
  options: JwtSubjectOptions,
): {
  readonly subject:
    | ReturnType<typeof anonymousSubject>
    | {
        readonly principal: JwtPrincipal;
        readonly actor?: Actor;
        readonly delegation?: Delegation;
        readonly context: Readonly<Record<string, unknown>>;
        readonly session?: string;
        readonly expiresAt?: number;
      };
  readonly invalidClaims: boolean;
  readonly invalidChain: boolean;
} {
  const paths = options.claims;
  const idPath = paths?.id ?? DEFAULT_CLAIMS.id;
  const id = readPath(claims, idPath);
  if (typeof id !== 'string' || id.length === 0) {
    return {
      subject: anonymousSubject(),
      invalidClaims: false,
      invalidChain: false,
    };
  }
  const tenantPath = paths?.tenant;
  const tenant =
    tenantPath === undefined ? undefined : readPath(claims, tenantPath);
  const activeTenant = typeof tenant === 'string' ? tenant : undefined;
  const roles = [
    ...asStringArray(readPath(claims, paths?.roles ?? DEFAULT_CLAIMS.roles)),
    ...asStringArray(
      readPath(claims, paths?.entitlements ?? DEFAULT_CLAIMS.entitlements),
    ),
  ];
  const groups = asStringArray(
    readPath(claims, paths?.groups ?? DEFAULT_CLAIMS.groups),
  );
  const claimedMemberships = membershipsFromClaim(
    paths?.memberships === undefined
      ? undefined
      : readPath(claims, paths.memberships),
  );
  const memberships = [
    ...claimedMemberships,
    ...membershipsFromGroups(groups, options.groupRoles, activeTenant),
  ];
  const reserved = [
    'iss',
    'sub',
    'aud',
    'exp',
    'nbf',
    'iat',
    'jti',
    'client_id',
    'scope',
    'cnf',
    'act',
    'sid',
    'acr',
    'amr',
    'auth_time',
    'roles',
    'groups',
    'entitlements',
    'authorization_details',
    'access',
    'nonce',
    'azp',
  ];
  let extra = customClaims(claims, reserved);
  let invalidClaims = false;
  if (options.schema !== undefined) {
    const validated = validateCustomClaims(extra, options.schema);
    if (validated.ok) {
      extra = validated.value;
    } else {
      extra = {};
      invalidClaims = true;
    }
  }
  const binding = bindingOf(claims);
  const act = actorFromAct(claims, options);
  if (act.status === 'invalid') {
    return {
      subject: anonymousSubject(),
      invalidClaims: false,
      invalidChain: true,
    };
  }
  const principal = freezeDeep(
    compact<JwtPrincipal>({
      id,
      issuer: typeof claims.iss === 'string' ? claims.iss : options.issuer,
      kind: kindOf(claims, paths),
      roles: roles.length > 0 ? roles : undefined,
      memberships: memberships.length > 0 ? memberships : undefined,
      tenant: activeTenant,
      assurance: assuranceOf(claims, paths),
      binding: act.status === 'absent' ? binding : undefined,
      claims: Object.keys(extra).length === 0 ? undefined : extra,
    }),
  );
  const actor =
    act.status === 'absent'
      ? undefined
      : freezeDeep(compact<Actor>({ ...act.actor, binding }));
  const sessionPath = paths?.session ?? DEFAULT_CLAIMS.session;
  const sessionValue = readPath(claims, sessionPath);
  const sessionExpiry = claims.session_expiry;
  const exp = typeof claims.exp === 'number' ? claims.exp : undefined;
  const expiresAt =
    typeof sessionExpiry === 'number' && exp !== undefined
      ? Math.min(exp, sessionExpiry)
      : exp;
  return {
    subject: freezeDeep(
      compact({
        principal,
        actor,
        delegation:
          options.accept === 'id-token'
            ? undefined
            : delegationOf(
                claims,
                options,
                act.status === 'ok' ? act.chain : undefined,
              ),
        context: {},
        session: typeof sessionValue === 'string' ? sessionValue : undefined,
        expiresAt,
      }),
    ),
    invalidClaims,
    invalidChain: false,
  };
}

export function acceptMismatch(
  claims: JwtClaims,
  headerTyp: string | undefined,
  options: JwtSubjectOptions,
  audience: string | readonly string[] | undefined,
): boolean {
  const accept = options.accept ?? 'access-token';
  const typ = headerTyp?.toLowerCase();
  if (accept === 'id-token') {
    if (typ !== undefined && typ !== 'jwt' && typ !== 'application/jwt') {
      return true;
    }
    const aud = claims.aud;
    const audiences = Array.isArray(aud) ? aud : aud === undefined ? [] : [aud];
    if (audiences.length > 1 && claims.azp !== audience) {
      return true;
    }
    return false;
  }
  if (options.profile === 'fapi2' && typ !== 'at+jwt') {
    return true;
  }
  if (typeof claims.nonce === 'string') {
    return true;
  }
  if (audience !== undefined && typeof claims.aud === 'string') {
    const expected = typeof audience === 'string' ? audience : audience[0];
    if (claims.aud !== expected && typ !== 'at+jwt') {
      return true;
    }
  }
  return false;
}
