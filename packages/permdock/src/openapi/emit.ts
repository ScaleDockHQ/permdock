import type { Condition } from '../conditions/ast.ts';
import type { Grantee } from '../core/grantee.ts';
import type { Permission } from '../core/permissions.ts';
import type { Grant, Policy } from '../core/policy.ts';
import type {
  OpenApiDescribe,
  OpenApiPermDockOptions,
  OpenApiSecurityRequirement,
  OpenApiTarget,
} from './types.ts';

import { requiresApproval } from '../core/approval-required.ts';
import { compact } from '../core/compact.ts';
import { isPermission, listPermissions } from '../core/permissions.ts';
import {
  DRAFT_PINS,
  GNAP_RESERVED,
  PROFILE_NAMES,
  PROFILE_PARAMETERS,
} from './pins.ts';

function assertScheme(options: OpenApiPermDockOptions): void {
  if (options.scheme.type === 'gnap') {
    throw new TypeError(GNAP_RESERVED);
  }
}

export function asList(
  permission: Permission | readonly Permission[],
): readonly Permission[] {
  return isPermission(permission) ? [permission] : permission;
}

function grantsOf(
  policy: Policy,
  permissions: readonly Permission[],
): readonly Grant[] {
  const keys = new Set(permissions.map((leaf) => leaf.key));
  return policy.grants.filter((grant) => keys.has(grant.permission.key));
}

function grantsAnyone(grant: Grant): boolean {
  const to = Array.isArray(grant.to) ? grant.to : [grant.to];
  // SAFETY: to is Grantee | readonly Grantee[]; Array.isArray does not narrow readonly arrays.
  return (to as readonly Grantee[]).some(
    (grantee) => grantee.kind === 'anyone',
  );
}

/** Every subject is granted it: an unconditional allow to `anyone()` and no deny. */
function isPublic(policy: Policy, permission: Permission): boolean {
  const grants = grantsOf(policy, [permission]);
  return (
    grants.every((grant) => grant.effect === 'allow') &&
    grants.some(
      (grant) =>
        grantsAnyone(grant) &&
        grant.where === undefined &&
        grant.check === undefined &&
        grant.approval === undefined &&
        grant.closure === undefined &&
        grant.limit === undefined &&
        grant.purpose === undefined &&
        grant.viaOnly === undefined,
    )
  );
}

function mergeRecord(
  base: Readonly<Record<string, unknown>>,
  extra: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(base)) {
    result[key] = value;
  }
  for (const [key, value] of Object.entries(extra)) {
    result[key] = value;
  }
  return result;
}

function scopesOf(policy: Policy): Readonly<Record<string, string>> {
  const scopes: Record<string, string> = {};
  for (const leaf of listPermissions(policy.permissions)) {
    scopes[leaf.scope] = leaf.meta.description ?? leaf.meta.title ?? leaf.key;
  }
  return scopes;
}

function flowWithScopes(
  flow: Readonly<Record<string, unknown>> | undefined,
  scopes: Readonly<Record<string, string>>,
): Record<string, unknown> {
  return mergeRecord(flow ?? {}, { scopes });
}

export function securitySchemesOf(
  policy: Policy,
  options: OpenApiPermDockOptions,
): Record<string, unknown> {
  assertScheme(options);
  const target = options.target ?? '3.2';
  const scopes = scopesOf(policy);
  const name = options.scheme.name;
  if (options.scheme.ref !== undefined && target !== '3.1') {
    return { [name]: { $ref: options.scheme.ref } };
  }
  const flowsIn = options.scheme.flows ?? { authorizationCode: {} };
  const flows: Record<string, unknown> = {};
  if (flowsIn.authorizationCode !== undefined) {
    flows['authorizationCode'] = flowWithScopes(
      flowsIn.authorizationCode,
      scopes,
    );
  }
  if (flowsIn.clientCredentials !== undefined) {
    flows['clientCredentials'] = flowWithScopes(
      flowsIn.clientCredentials,
      scopes,
    );
  }
  if (flowsIn.deviceAuthorization !== undefined) {
    if (target === '3.1') {
      const { deviceAuthorizationUrl, ...rest } = flowsIn.deviceAuthorization;
      flows['x-oai-deviceAuthorization'] = flowWithScopes(
        compact({
          ...rest,
          'x-oai-deviceAuthorizationUrl': deviceAuthorizationUrl,
        }),
        scopes,
      );
    } else {
      flows['deviceAuthorization'] = flowWithScopes(
        flowsIn.deviceAuthorization,
        scopes,
      );
    }
  }
  const scheme = compact<Record<string, unknown>>({
    type: options.scheme.type,
    flows: options.scheme.type === 'oauth2' ? flows : undefined,
    openIdConnectUrl:
      options.scheme.type === 'openIdConnect'
        ? options.scheme.openIdConnectUrl
        : undefined,
    oauth2MetadataUrl:
      target === '3.2' || target === '3.3'
        ? options.scheme.oauth2MetadataUrl
        : undefined,
    'x-permdock-oauth2MetadataUrl':
      target === '3.1' ? options.scheme.oauth2MetadataUrl : undefined,
    deprecated:
      target !== '3.1' && options.scheme.deprecated === true ? true : undefined,
    'x-oai-deprecated':
      target === '3.1' && options.scheme.deprecated === true ? true : undefined,
    'x-permdock-securityProfile': options.securityProfile,
  });
  const schemes: Record<string, unknown> = { [name]: scheme };
  if (target === '3.3' && options.securityProfile !== undefined) {
    const profileName = options.profileScheme ?? 'permdockFapi2';
    schemes[profileName] = compact({
      type: 'profile',
      profileMetadata: compact({
        name: PROFILE_NAMES[options.securityProfile],
        supportedParametersSchema: PROFILE_PARAMETERS[options.securityProfile],
        servers:
          options.scheme.oauth2MetadataUrl === undefined
            ? undefined
            : [{ name: 'default', url: options.scheme.oauth2MetadataUrl }],
      }),
      'x-permdock-securityProfile': options.securityProfile,
    });
  }
  return schemes;
}

export function securityOf(
  policy: Policy,
  options: OpenApiPermDockOptions,
  permissions: readonly Permission[],
  anyOf?: boolean,
): readonly OpenApiSecurityRequirement[] {
  assertScheme(options);
  const name = options.scheme.name;
  const open =
    anyOf === true
      ? permissions.some((leaf) => isPublic(policy, leaf))
      : permissions.length > 0 &&
        permissions.every((leaf) => isPublic(policy, leaf));
  if (open) {
    return [];
  }
  if (anyOf === true) {
    return permissions.map((leaf) => ({ [name]: [leaf.scope] }));
  }
  return [{ [name]: permissions.map((leaf) => leaf.scope) }];
}

export function describeOf(
  policy: Policy,
  options: OpenApiPermDockOptions,
  permissions: readonly Permission[],
  anyOf?: boolean,
): OpenApiDescribe {
  const conditions: Record<string, Condition> = {};
  const approvals: Record<string, { readonly reason: 'human' }> = {};
  for (const leaf of permissions) {
    const grants = grantsOf(policy, [leaf]).filter(
      (grant) => grant.effect === 'allow',
    );
    const wheres = grants
      .filter((grant) => grant.portable)
      .map((grant) => grant.where)
      .filter((where) => where !== undefined);
    const [only] = wheres;
    if (only !== undefined) {
      conditions[leaf.key] =
        wheres.length === 1 ? only : { op: 'or', conditions: wheres };
    }
    if (grants.some((grant) => requiresApproval(grant.approval))) {
      approvals[leaf.key] = { reason: 'human' };
    }
  }
  const approval = Object.keys(approvals).length > 0;
  return compact<OpenApiDescribe>({
    security: securityOf(policy, options, permissions, anyOf),
    'x-permdock-permissions': permissions.map((leaf) => leaf.key),
    'x-permdock-conditions':
      Object.keys(conditions).length > 0 ? conditions : undefined,
    'x-permdock-approval': approval ? approvals : undefined,
    'x-permdock-securityProfile': options.securityProfile,
    'x-badges':
      options.docsHints?.badges === true && approval
        ? [{ name: 'Approval required' }]
        : undefined,
  });
}

export function catalogOf(
  options: OpenApiPermDockOptions,
  extraDrafts?: Readonly<Record<string, string>>,
): Record<string, unknown> {
  const target = options.target ?? '3.2';
  const drafts: Record<string, string> = {};
  if (target === '3.3') {
    drafts['oas'] = DRAFT_PINS.oas;
    drafts['securityProfiles'] = DRAFT_PINS.securityProfiles;
  }
  if (extraDrafts !== undefined) {
    for (const [key, value] of Object.entries(extraDrafts)) {
      drafts[key] = value;
    }
  }
  return compact({
    v: 1,
    generator: 'permdock/openapi',
    drafts: Object.keys(drafts).length > 0 ? drafts : undefined,
  });
}

const GRANT_TYPES = {
  authorizationCode: 'authorization_code',
  clientCredentials: 'client_credentials',
  deviceAuthorization: 'urn:ietf:params:oauth:grant-type:device_code',
} as const;

const FLOWS = [
  'authorizationCode',
  'clientCredentials',
  'deviceAuthorization',
] as const;

/** The client authentication methods FAPI 2.0 section 5.3.2.1 allows: sender-constrained, no shared secret. */
const FAPI2_AUTH_METHODS = ['private_key_jwt', 'tls_client_auth'] as const;

function pascal(value: string): string {
  return value
    .split(/[^A-Za-z0-9]+/u)
    .filter((part) => part.length > 0)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join('');
}

/**
 * One Security Profile Requirement per distinct scope set: `scopeSets` from
 * the operations, else one per permission.
 */
export function securityProfileRequirementsOf(
  policy: Policy,
  options: OpenApiPermDockOptions,
  scopeSets?: readonly (readonly string[])[],
): Record<string, unknown> | undefined {
  if (
    (options.target ?? '3.2') !== '3.3' ||
    options.securityProfile === undefined
  ) {
    return undefined;
  }
  const profileName = options.profileScheme ?? 'permdockFapi2';
  const flows = options.scheme.flows ?? { authorizationCode: {} };
  const grantTypes = FLOWS.filter((flow) => flows[flow] !== undefined).map(
    (flow) => GRANT_TYPES[flow],
  );
  const sets =
    scopeSets ??
    listPermissions(policy.permissions).map((leaf) => [leaf.scope]);
  const requirements: Record<string, unknown> = {};
  for (const set of sets) {
    const scopes = [...new Set(set)].toSorted();
    if (scopes.length === 0) {
      continue;
    }
    requirements[`${profileName}${pascal(scopes.join(' '))}`] = {
      securityScheme: { $ref: `#/components/securitySchemes/${profileName}` },
      token_endpoint_auth_methods: [...FAPI2_AUTH_METHODS],
      grant_types: grantTypes,
      scopes,
    };
  }
  return requirements;
}

export function openapiVersion(target: OpenApiTarget): string {
  switch (target) {
    case '3.1':
      return '3.1.0';
    case '3.2':
      return '3.2.0';
    case '3.3':
      return '3.3.0';
    default: {
      const exhaustive: never = target;
      return exhaustive;
    }
  }
}
