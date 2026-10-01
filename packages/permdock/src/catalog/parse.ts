import type { StandardSchemaV1 } from '@standard-schema/spec';

import type { CatalogSchemaNode } from './schema.ts';
import type { CatalogDocument } from './types.ts';

import { PermDockValidationError } from '../core/errors.ts';
import { freezeDeep } from '../core/freeze.ts';
import { catalogSchema } from './schema.ts';

type Path = readonly PropertyKey[];
type Issues = StandardSchemaV1.Issue[];

function issue(issues: Issues, path: Path, message: string): void {
  issues.push({ message, path: [...path] });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * A plain-data copy built from own enumerable keys, so `__proto__` stays an
 * ordinary key and nothing the input inherits is read. Anything JSON cannot
 * carry is an issue.
 */
function copyJson(
  value: unknown,
  path: Path,
  issues: Issues,
  ancestors: Set<object>,
): unknown {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      issue(issues, path, 'Expected a finite number');
    }
    return value;
  }
  if (typeof value !== 'object') {
    issue(issues, path, `Expected JSON, got ${typeof value}`);
    return undefined;
  }
  if (ancestors.has(value)) {
    issue(issues, path, 'Expected JSON, got a cycle');
    return undefined;
  }
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item: unknown, index) =>
        copyJson(item, [...path, index], issues, ancestors),
      );
    }
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      issue(issues, path, 'Expected a plain object');
      return undefined;
    }
    return Object.fromEntries(
      Object.keys(value).map((key): [string, unknown] => [
        key,
        copyJson(Reflect.get(value, key), [...path, key], issues, ancestors),
      ]),
    );
  } finally {
    ancestors.delete(value);
  }
}

function typeMatches(
  type: NonNullable<CatalogSchemaNode['type']>,
  value: unknown,
): boolean {
  switch (type) {
    case 'object':
      return isRecord(value);
    case 'array':
      return Array.isArray(value);
    case 'string':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    case 'integer':
      return Number.isInteger(value);
    default: {
      const unreachable: never = type;
      return unreachable;
    }
  }
}

/** The subset of JSON Schema 2020-12 `CatalogSchemaNode` names, over a `copyJson` result. */
function checkSchema(
  node: CatalogSchemaNode,
  value: unknown,
  path: Path,
  issues: Issues,
): void {
  if ('const' in node && value !== node.const) {
    issue(issues, path, `Expected ${JSON.stringify(node.const)}`);
    return;
  }
  if (node.enum !== undefined && !node.enum.includes(value)) {
    issue(
      issues,
      path,
      `Expected one of ${node.enum.map((item) => JSON.stringify(item)).join(', ')}`,
    );
    return;
  }
  if (node.type !== undefined && !typeMatches(node.type, value)) {
    issue(issues, path, `Expected ${node.type}`);
    return;
  }
  if (
    node.pattern !== undefined &&
    typeof value === 'string' &&
    !new RegExp(node.pattern, 'u').test(value)
  ) {
    issue(issues, path, `Expected a string matching ${node.pattern}`);
  }
  if (
    node.minimum !== undefined &&
    typeof value === 'number' &&
    value < node.minimum
  ) {
    issue(issues, path, `Expected at least ${String(node.minimum)}`);
  }
  if (node.oneOf !== undefined) {
    const matches = node.oneOf.filter((option) => {
      const scratch: Issues = [];
      checkSchema(option, value, path, scratch);
      return scratch.length === 0;
    }).length;
    if (matches !== 1) {
      issue(issues, path, 'Expected exactly one matching form');
    }
  }
  if (Array.isArray(value) && node.items !== undefined) {
    for (const [index, item] of value.entries()) {
      checkSchema(node.items, item, [...path, index], issues);
    }
  }
  if (!isRecord(value)) {
    return;
  }
  for (const key of node.required ?? []) {
    if (!Object.hasOwn(value, key)) {
      issue(issues, [...path, key], 'Required');
    }
  }
  const properties = node.properties ?? {};
  for (const key of Object.keys(value)) {
    const child = Object.hasOwn(properties, key)
      ? properties[key]
      : node.additionalProperties;
    if (child !== undefined) {
      checkSchema(child, value[key], [...path, key], issues);
    }
  }
}

function invalid(issues: readonly StandardSchemaV1.Issue[]): never {
  const [first] = issues;
  const where =
    first?.path === undefined || first.path.length === 0
      ? ''
      : ` at ${first.path.map(String).join('.')}`;
  const more =
    issues.length > 1 ? ` (and ${String(issues.length - 1)} more)` : '';
  throw new PermDockValidationError({
    code: 'invalid-data',
    permission: '',
    resource: '',
    boundary: 'catalog',
    issues,
    message: `PermDock: invalid catalog${where}: ${first?.message ?? 'unknown'}${more}`,
  });
}

/**
 * Reads a `permissions.catalog.json` document (parsed, or the JSON text) and
 * validates it against `schemas/catalog-v1.json`. Returns a deep-frozen copy
 * built from own keys; throws `PermDockValidationError` with every issue.
 */
export function parseCatalog(json: unknown): CatalogDocument {
  const issues: Issues = [];
  let input = json;
  if (typeof json === 'string') {
    try {
      input = JSON.parse(json);
    } catch (error) {
      invalid([
        {
          message: `Expected JSON text: ${error instanceof Error ? error.message : String(error)}`,
          path: [],
        },
      ]);
    }
  }
  let copy: unknown;
  try {
    copy = copyJson(input, [], issues, new Set());
  } catch (error) {
    invalid([
      {
        message: `Could not read the input: ${error instanceof Error ? error.message : String(error)}`,
        path: [],
      },
    ]);
  }
  if (issues.length === 0) {
    checkSchema(catalogSchema, copy, [], issues);
  }
  if (issues.length > 0) {
    invalid(issues);
  }
  // SAFETY: copy is plain JSON that passed catalogSchema, the schema CatalogDocument describes.
  return freezeDeep(copy as CatalogDocument);
}

/** Keys of the permissions the catalog marks `rowConditions: true`: the SQL helpers alone cannot enforce them. */
export function rowConditionKeys(
  catalog: CatalogDocument,
): ReadonlySet<string> {
  return new Set(
    catalog.permissions
      .filter((permission) => permission.rowConditions === true)
      .map((permission) => permission.key),
  );
}
