import type { ActionMeta, PermissionTree, ResourceNode } from 'permdock';

import { getResource, listPermissions } from 'permdock';

import type { CatalogDocument, CatalogUsage, ScanResult } from './types.ts';

import { CATALOG_SCHEMA, generatorBanner } from './version.ts';

export function buildCatalog(
  tree: PermissionTree,
  scan: ScanResult,
  generatedAt: string,
): CatalogDocument {
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
    .map((leaf) => ({
      key: leaf.key,
      scope: leaf.scope,
      resource: leaf.resource,
      action: leaf.action,
      arity: leaf.kind,
      meta: metaRecord(leaf.meta),
      usages: scan.usages[leaf.key] ?? [],
    }))
    .toSorted((a, b) => a.key.localeCompare(b.key));
  return {
    $schema: CATALOG_SCHEMA,
    version: 1,
    generatedAt,
    generator: generatorBanner(),
    resources,
    permissions,
    ...(scan.roleNames.length === 0
      ? {}
      : { roles: scan.roleNames.map((key) => ({ key })) }),
    ...(scan.planNames.length === 0
      ? {}
      : { plans: scan.planNames.map((key) => ({ key })) }),
  };
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

function jsonSchemaOf(node: ResourceNode): unknown {
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
      roles: { type: 'array' },
      plans: { type: 'array' },
      permissions: {
        type: 'array',
        items: {
          type: 'object',
          required: ['key', 'resource', 'action', 'arity', 'scope'],
        },
      },
    },
  };
}
