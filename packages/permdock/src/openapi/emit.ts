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
import { listPermissions } from '../core/permissions.ts';
import { DRAFT_PINS, GNAP_RESERVED, PROFILE_NAMES } from './pins.ts';

export function assertScheme(options: OpenApiPermDockOptions): void {
  if (options.scheme.type === 'gnap') {
    throw new TypeError(GNAP_RESERVED);
  }
}

function isLeaf(
  value: Permission | readonly Permission[],
): value is Permission {
  return (
    typeof value === 'object' &&
    value !== null &&
    'key' in value &&
    'kind' in value &&
    'action' in value
  );
}

export function asList(
  permission: Permission | readonly Permission[],
): readonly Permission[] {
  return isLeaf(permission) ? [permission] : permission;
}

export function grantsOf(
  policy: Policy,
  permissions: readonly Permission[],
): readonly Grant[] {
  const keys = new Set(permissions.map((leaf) => leaf.key));
  return policy.roles.flatMap((role) =>
    role.grants.filter((grant) => keys.has(grant.permission.key)),
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

export function scopesOf(policy: Policy): Readonly<Record<string, string>> {
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
    flows.authorizationCode = flowWithScopes(flowsIn.authorizationCode, scopes);
  }
  if (flowsIn.clientCredentials !== undefined) {
    flows.clientCredentials = flowWithScopes(flowsIn.clientCredentials, scopes);
  }
  if (flowsIn.deviceAuthorization !== undefined && target !== '3.1') {
    flows.deviceAuthorization = flowWithScopes(
      flowsIn.deviceAuthorization,
      scopes,
    );
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
    'x-oai-deviceAuthorization':
      target === '3.1' && flowsIn.deviceAuthorization !== undefined
        ? flowWithScopes(flowsIn.deviceAuthorization, scopes)
        : undefined,
    'x-oai-deviceAuthorizationUrl':
      target === '3.1' && flowsIn.deviceAuthorization !== undefined
        ? options.scheme.oauth2MetadataUrl
        : undefined,
    'x-permdock-securityProfile': options.securityProfile,
  });
  const schemes: Record<string, unknown> = { [name]: scheme };
  if (target === '3.3' && options.securityProfile !== undefined) {
    const profileName = options.profileScheme ?? 'permdockFapi2';
    schemes[profileName] = compact({
      type: 'profile',
      profileMetadata: compact({
        name: PROFILE_NAMES[options.securityProfile],
        supportedParametersSchema: {
          $ref: 'https://permdock.dev/schemas/fapi2-parameters.json',
        },
        servers:
          options.scheme.oauth2MetadataUrl === undefined
            ? undefined
            : [{ url: options.scheme.oauth2MetadataUrl }],
      }),
      'x-permdock-securityProfile': options.securityProfile,
    });
  }
  return schemes;
}

export function securityOf(
  options: OpenApiPermDockOptions,
  permissions: readonly Permission[],
  anyOf?: boolean,
): readonly OpenApiSecurityRequirement[] {
  assertScheme(options);
  const name = options.scheme.name;
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
  const grants = grantsOf(policy, permissions);
  const conditions = grants
    .map((grant) => grant.where)
    .filter((where) => where !== undefined);
  const approval = grants.some((grant) => requiresApproval(grant.approval));
  return compact<OpenApiDescribe>({
    security: securityOf(options, permissions, anyOf),
    'x-permdock-permissions': permissions.map((leaf) => leaf.key),
    'x-permdock-conditions': conditions.length > 0 ? conditions : undefined,
    'x-permdock-approval': approval ? 'human' : undefined,
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
    drafts.oas = DRAFT_PINS.oas;
    drafts.securityProfiles = DRAFT_PINS.securityProfiles;
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

export function securityProfileRequirementsOf(
  policy: Policy,
  options: OpenApiPermDockOptions,
): Record<string, unknown> | undefined {
  if (
    (options.target ?? '3.2') !== '3.3' ||
    options.securityProfile === undefined
  ) {
    return undefined;
  }
  const profileName = options.profileScheme ?? 'permdockFapi2';
  const scopes = Object.keys(scopesOf(policy)).toSorted();
  const key = scopes.join(',');
  return {
    [key]: {
      [profileName]: {
        scopes,
      },
    },
  };
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
