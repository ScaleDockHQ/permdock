import type {
  ActionMeta,
  PermissionTree,
  Policy,
  ResourceNode,
} from 'permdock';

import { getResource, listPermissions } from 'permdock';

import type { CatalogDocument, CatalogUsage, ScanResult } from './types.ts';

import { CATALOG_SCHEMA, generatorBanner } from './version.ts';

/** With `policy`, permissions carry `hostable` and roles carry `on` and `assignable`. */
export function buildCatalog(
  tree: PermissionTree,
  scan: ScanResult,
  generatedAt: string,
  policy?: Policy,
): CatalogDocument {
  const hostable = new Set(policy?.hostable ?? []);
  const resources: Record<string, CatalogDocument['resources'][string]> = {};
  const definedIn = scan.definitionFiles.permissions;
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
          }
        : {
            id: node?.id ?? 'id',
            schema: node === undefined ? null : jsonSchemaOf(node),
            definedIn,
            relations: node?.relations,
          },
    );
  }
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
      }),
    )
    .toSorted((a, b) => a.key.localeCompare(b.key));
  return {
    $schema: CATALOG_SCHEMA,
    version: 1,
    generatedAt,
    generator: generatorBanner(),
    resources,
    permissions,
    ...catalogRoles(scan.roleNames, policy),
    ...(scan.planNames.length === 0
      ? {}
      : { plans: scan.planNames.map((key) => ({ key })) }),
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
      return binding === undefined
        ? { key }
        : withDefined({
            key,
            on:
              binding.on === undefined
                ? undefined
                : typeof binding.on === 'string'
                  ? binding.on
                  : ('resource' as const),
            assignable: binding.assignable,
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
}): CatalogDocument['resources'][string] {
  const relations =
    resource.relations !== undefined &&
    Object.keys(resource.relations).length > 0
      ? resource.relations
      : undefined;
  if (resource.definedIn === undefined) {
    return relations === undefined
      ? { id: resource.id, schema: resource.schema }
      : { id: resource.id, schema: resource.schema, relations };
  }
  return relations === undefined
    ? {
        id: resource.id,
        schema: resource.schema,
        definedIn: resource.definedIn,
      }
    : {
        id: resource.id,
        schema: resource.schema,
        definedIn: resource.definedIn,
        relations,
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
  const { generatedAt: _generatedAt, ...rest } = doc;
  return `${JSON.stringify(rest, null, 2)}\n`;
}

export function usagesOf(
  doc: CatalogDocument,
): Readonly<Record<string, readonly CatalogUsage[]>> {
  const out: Record<string, readonly CatalogUsage[]> = {};
  for (const permission of doc.permissions) {
    if (permission.usages.length > 0) {
      out[permission.key] = permission.usages;
    }
  }
  return out;
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
      resources: { type: 'object' },
      roles: {
        type: 'array',
        items: {
          type: 'object',
          required: ['key'],
          properties: {
            key: { type: 'string' },
            on: { enum: ['tenant', 'team', 'resource'] },
            assignable: { type: 'boolean' },
          },
        },
      },
      plans: { type: 'array' },
      permissions: {
        type: 'array',
        items: {
          type: 'object',
          required: ['key', 'resource', 'action', 'arity', 'scope'],
          properties: { hostable: { const: true } },
        },
      },
    },
  };
}
