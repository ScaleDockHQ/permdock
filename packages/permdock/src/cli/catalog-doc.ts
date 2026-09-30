import type {
  ActionMeta,
  Grant,
  PermissionTree,
  Policy,
  ResourceNode,
} from '../index.ts';
import type {
  CatalogApproval,
  CatalogBreakGlass,
  CatalogDocument,
  ScanResult,
} from './types.ts';

import {
  catalogFingerprint,
  findRole,
  getResource,
  listPermissions,
} from '../index.ts';
import { CATALOG_SCHEMA, generatorBanner } from './version.ts';

const ROW_GRANTEES = new Set(['relation', 'plan', 'actor', 'assurance']);

/**
 * Whether a grant depends on more than the role and the scope: a row or body
 * condition, a closure, a field list, a purpose, a break-glass override, or a
 * relation, plan, actor or assurance grantee. The SQL helpers
 * (`permdock_has`, `permitted_<scope>_ids`) check only role and scope, so a
 * policy that calls them for such a permission would widen access.
 */
function grantHasRowConditions(grant: Grant): boolean {
  const grantees = Array.isArray(grant.to) ? grant.to : [grant.to];
  return (
    grant.where !== undefined ||
    grant.check !== undefined ||
    grant.closure !== undefined ||
    !grant.portable ||
    grant.fields !== undefined ||
    grant.purpose !== undefined ||
    grant.breakGlass !== undefined ||
    grantees.some((grantee: { readonly kind: string }) =>
      ROW_GRANTEES.has(grantee.kind),
    )
  );
}

/** Per permission key, whether any code grant for it has row conditions. */
export function rowConditionKeys(policy: Policy): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const grant of [
    ...policy.grants,
    ...policy.roles.flatMap((binding) => binding.grants),
  ]) {
    if (grant.hosted === undefined && grantHasRowConditions(grant)) {
      keys.add(grant.permission.key);
    }
  }
  return keys;
}

/** With `policy`, permissions carry `hostable` and `rowConditions`, and roles carry `on`, `assignable` and their ownership rules. */
export function buildCatalog(
  tree: PermissionTree,
  scan: ScanResult,
  generatedAt: string,
  policy?: Policy,
): CatalogDocument {
  const hostable = new Set(policy?.hostable ?? []);
  const rowConditions =
    policy === undefined ? undefined : rowConditionKeys(policy);
  const resources: Record<string, CatalogDocument['resources'][string]> = {};
  const definedIn = scan.definitionFiles['permissions'];
  for (const leaf of listPermissions(tree)) {
    if (resources[leaf.resource] !== undefined) {
      continue;
    }
    const node = getResource(tree, leaf.resource);
    resources[leaf.resource] = compactResource(
      definedIn === undefined
        ? {
            id: node?.id ?? 'id',
            schema: node === undefined ? null : jsonSchemaOf(node),
            relations: node?.relations,
            version: node?.version,
            restricted: node?.restricted,
          }
        : {
            id: node?.id ?? 'id',
            schema: node === undefined ? null : jsonSchemaOf(node),
            definedIn,
            relations: node?.relations,
            version: node?.version,
            restricted: node?.restricted,
          },
    );
  }
  const approvals = codeApprovals(policy);
  const breakGlass = codeBreakGlass(policy);
  const permissions = listPermissions(tree)
    .map((leaf) =>
      withDefined({
        key: leaf.key,
        scope: leaf.scope,
        resource: leaf.resource,
        action: leaf.action,
        arity: leaf.kind,
        meta: metaRecord(leaf.meta),
        usages: scan.usages[leaf.key] ?? [],
        hostable: hostable.has(leaf.key) ? (true as const) : undefined,
        rowConditions: rowConditions?.has(leaf.key),
        approvals: approvals.get(leaf.key),
        breakGlass: breakGlass.get(leaf.key),
      }),
    )
    .toSorted((a, b) => a.key.localeCompare(b.key));
  const body = {
    resources,
    permissions,
    ...catalogScopes(policy),
    ...catalogRoles(scan.roleNames, policy),
    ...(scan.planNames.length === 0
      ? {}
      : { plans: scan.planNames.map((key) => ({ key })) }),
  };
  const head = {
    $schema: CATALOG_SCHEMA,
    version: 1 as const,
    generatedAt,
    generator: generatorBanner(),
  };
  return {
    ...head,
    fingerprint: catalogFingerprint({ ...head, ...body }),
    ...body,
  };
}

/** Per permission key, the distinct approvals the code allows require, in policy order. */
function codeApprovals(
  policy: Policy | undefined,
): ReadonlyMap<string, readonly CatalogApproval[]> {
  const out = new Map<string, CatalogApproval[]>();
  const seen = new Set<string>();
  for (const grant of policy?.grants ?? []) {
    if (
      grant.effect !== 'allow' ||
      grant.hosted !== undefined ||
      grant.approval === undefined
    ) {
      continue;
    }
    const approval: CatalogApproval =
      grant.approval === 'human'
        ? 'human'
        : withDefined({
            by: grant.approval.by,
            distinct: grant.approval.distinct,
            staleOn: grant.approval.staleOn,
          });
    const id = `${grant.permission.key}\u0000${JSON.stringify(approval)}`;
    if (seen.has(id)) {
      continue;
    }
    seen.add(id);
    out.set(grant.permission.key, [
      ...(out.get(grant.permission.key) ?? []),
      approval,
    ]);
  }
  return out;
}

/** Per permission key, the break-glass override a `breakGlass` grant declares. */
function codeBreakGlass(
  policy: Policy | undefined,
): ReadonlyMap<string, CatalogBreakGlass> {
  const out = new Map<string, CatalogBreakGlass>();
  for (const grant of policy?.grants ?? []) {
    if (grant.breakGlass === undefined) {
      continue;
    }
    out.set(
      grant.permission.key,
      withDefined({
        overrides: grant.breakGlass.overrides,
        purpose: grant.breakGlass.purpose,
        reason: grant.breakGlass.reason,
        maxDuration: grant.breakGlass.maxDuration,
        obligations: grant.breakGlass.obligations,
      }),
    );
  }
  return out;
}

function catalogScopes(
  policy: Policy | undefined,
): Pick<CatalogDocument, 'scopes'> {
  const scopes = policy?.scopes ?? [];
  return scopes.length === 0
    ? {}
    : {
        scopes: scopes.map((scope) =>
          withDefined({
            name: scope.name,
            key: scope.key ?? '',
            within: scope.within,
          }),
        ),
      };
}

function catalogRoles(
  scanned: readonly string[],
  policy: Policy | undefined,
): Pick<CatalogDocument, 'roles'> {
  if (policy === undefined) {
    return scanned.length === 0
      ? {}
      : { roles: scanned.map((key) => ({ key })) };
  }
  const names = [
    ...new Set([...scanned, ...policy.roles.map((role) => role.name)]),
  ].toSorted();
  if (names.length === 0) {
    return {};
  }
  return {
    roles: names.map((key) => {
      const binding = policy.rolesByName.get(key);
      if (binding === undefined) {
        return { key };
      }
      const audience =
        binding.meta?.audience ??
        findRole(policy.vocabulary.roles, key)?.meta.audience;
      return withDefined({
        key,
        on:
          binding.on === undefined
            ? undefined
            : typeof binding.on === 'string'
              ? binding.on
              : ('resource' as const),
        assignable: binding.assignable,
        min: binding.min === 0 ? undefined : binding.min,
        max: binding.max,
        transferOnly:
          binding.transferOnly === true ? (true as const) : undefined,
        assigns: binding.assigns,
        for: binding.for,
        exclusiveWith: binding.exclusiveWith,
        audience,
        activation:
          binding.activation === undefined
            ? undefined
            : withDefined({
                maxDuration: binding.activation.maxDuration,
                justification: binding.activation.justification,
                approval:
                  binding.activation.approval === undefined ? undefined : true,
                assurance: binding.activation.assurance,
              }),
        supportAccess:
          binding.support === undefined
            ? undefined
            : {
                actorRequired: binding.support.actorRequired,
                group: binding.support.group,
                durations: binding.support.consent.durations,
              },
      });
    }),
  };
}

type Defined<T> = {
  [K in keyof T as undefined extends T[K] ? never : K]: T[K];
} & {
  [K in keyof T as undefined extends T[K] ? K : never]?: Exclude<
    T[K],
    undefined
  >;
};

function withDefined<T extends Record<string, unknown>>(value: T): Defined<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Defined<T>;
}

function compactResource(resource: {
  readonly id: string;
  readonly schema: unknown;
  readonly definedIn?: string;
  readonly relations?: CatalogDocument['resources'][string]['relations'];
  readonly version?: string | undefined;
  readonly restricted?: string | undefined;
}): CatalogDocument['resources'][string] {
  const relations =
    resource.relations !== undefined &&
    Object.keys(resource.relations).length > 0
      ? resource.relations
      : undefined;
  return {
    id: resource.id,
    schema: resource.schema,
    ...withDefined({
      definedIn: resource.definedIn,
      relations,
      version: resource.version,
      restricted: resource.restricted,
    }),
  };
}

function metaRecord(meta: ActionMeta): Readonly<Record<string, unknown>> {
  return { ...meta };
}

export function jsonSchemaOf(node: ResourceNode): unknown {
  const schema = node.schema as
    | {
        readonly '~standard'?: {
          readonly jsonSchema?: { readonly output?: () => unknown };
        };
      }
    | undefined;
  const output = schema?.['~standard']?.jsonSchema?.output;
  if (typeof output === 'function') {
    try {
      return output();
    } catch {
      return null;
    }
  }
  return null;
}

export function formatCatalogJson(doc: CatalogDocument): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

export function catalogForCompare(doc: CatalogDocument): string {
  const { generatedAt: _generatedAt, generator: _generator, ...rest } = doc;
  return `${JSON.stringify(rest, null, 2)}\n`;
}

export function formatCatalogMarkdown(doc: CatalogDocument): string {
  const lines = ['# Permissions', ''];
  const byResource = new Map<string, CatalogDocument['permissions']>();
  for (const permission of doc.permissions) {
    const current = byResource.get(permission.resource) ?? [];
    byResource.set(permission.resource, [...current, permission]);
  }
  for (const resource of [...byResource.keys()].toSorted()) {
    lines.push(`## ${resource}`, '');
    lines.push('| Action | Arity | Scope | Usages |');
    lines.push('| --- | --- | --- | --- |');
    for (const permission of byResource.get(resource) ?? []) {
      lines.push(
        `| \`${permission.action}\` | ${permission.arity} | \`${permission.scope}\` | ${String(permission.usages.length)} |`,
      );
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

export function catalogSchemaDocument(): unknown {
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: CATALOG_SCHEMA,
    type: 'object',
    required: ['$schema', 'version', 'permissions', 'resources'],
    properties: {
      $schema: { type: 'string' },
      version: { const: 1 },
      generatedAt: { type: 'string' },
      generator: { type: 'string' },
      fingerprint: { type: 'string' },
      resources: { type: 'object' },
      roles: {
        type: 'array',
        items: {
          type: 'object',
          required: ['key'],
          properties: {
            key: { type: 'string' },
            on: { type: 'string', pattern: '^[a-z][a-z0-9_]*$' },
            assignable: { type: 'boolean' },
            min: { type: 'integer', minimum: 1 },
            max: { type: 'integer', minimum: 1 },
            transferOnly: { const: true },
            assigns: { type: 'array', items: { type: 'string' } },
            for: { type: 'array', items: { type: 'string' } },
            exclusiveWith: { type: 'array', items: { type: 'string' } },
            audience: { type: 'string' },
          },
        },
      },
      scopes: {
        type: 'array',
        items: {
          type: 'object',
          required: ['name', 'key'],
          properties: {
            name: { type: 'string', pattern: '^[a-z][a-z0-9_]*$' },
            key: { type: 'string' },
            within: { type: 'string' },
          },
        },
      },
      plans: { type: 'array' },
      permissions: {
        type: 'array',
        items: {
          type: 'object',
          required: ['key', 'resource', 'action', 'arity', 'scope'],
          properties: {
            hostable: { const: true },
            rowConditions: { type: 'boolean' },
            approvals: {
              type: 'array',
              items: {
                oneOf: [
                  { const: 'human' },
                  {
                    type: 'object',
                    properties: { by: {}, distinct: { type: 'boolean' } },
                  },
                ],
              },
            },
          },
        },
      },
    },
  };
}
