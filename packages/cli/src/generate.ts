export type SchemaKind = 'zod' | 'valibot' | 'arktype';

export type JsonSchema = Readonly<Record<string, unknown>>;

export type GeneratedAction = {
  readonly title?: string;
  readonly description?: string;
  readonly tags?: readonly string[];
  readonly readOnly?: boolean;
  readonly inferredFrom?: string;
};

export type GeneratedResource = {
  /** Tree path of the resource, for example `['org', 'post']`. */
  readonly path: readonly string[];
  readonly id?: string;
  /** A validator expression from `schemaExpression`; omitted for a schema-less resource. */
  readonly schema?: string;
  readonly actions:
    | readonly string[]
    | Readonly<Record<string, GeneratedAction>>;
  readonly collection:
    | readonly string[]
    | Readonly<Record<string, GeneratedAction>>;
};

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;
const MAX_DEPTH = 6;

export function isSchemaKind(value: string | undefined): value is SchemaKind {
  return value === 'zod' || value === 'valibot' || value === 'arktype';
}

export function schemaImport(kind: SchemaKind): string {
  switch (kind) {
    case 'zod':
      return "import { z } from 'zod'";
    case 'valibot':
      return "import * as v from 'valibot'";
    case 'arktype':
      return "import { type } from 'arktype'";
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

export function emptySchema(kind: SchemaKind): string {
  return schemaExpression(kind, { type: 'object' });
}

function propertyKey(name: string): string {
  return IDENTIFIER.test(name) ? name : JSON.stringify(name);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function literalEnum(schema: JsonSchema): readonly string[] | undefined {
  const values = schema.enum;
  if (
    !Array.isArray(values) ||
    values.length === 0 ||
    !values.every((value) => typeof value === 'string')
  ) {
    return undefined;
  }
  return values as readonly string[];
}

function schemaType(schema: JsonSchema): string | undefined {
  const type = schema.type;
  if (typeof type === 'string') {
    return type;
  }
  if (Array.isArray(type)) {
    const named = type.filter((item) => item !== 'null');
    return named.length === 1 && typeof named[0] === 'string'
      ? named[0]
      : undefined;
  }
  return isRecord(schema.properties) ? 'object' : undefined;
}

type Resolve = (schema: JsonSchema) => JsonSchema;

function zodOf(schema: JsonSchema, resolve: Resolve, depth: number): string {
  const node = resolve(schema);
  const values = literalEnum(node);
  if (values !== undefined) {
    return `z.enum(${JSON.stringify(values)})`;
  }
  const type = depth > MAX_DEPTH ? undefined : schemaType(node);
  if (type === undefined) {
    return 'z.unknown()';
  }
  switch (type) {
    case 'string':
      return 'z.string()';
    case 'number':
      return 'z.number()';
    case 'integer':
      return 'z.number().int()';
    case 'boolean':
      return 'z.boolean()';
    case 'array':
      return `z.array(${isRecord(node.items) ? zodOf(node.items, resolve, depth + 1) : 'z.unknown()'})`;
    case 'object': {
      const required = new Set(
        Array.isArray(node.required) ? node.required : [],
      );
      const properties = isRecord(node.properties) ? node.properties : {};
      const fields = Object.entries(properties)
        .filter((entry): entry is [string, JsonSchema] => isRecord(entry[1]))
        .map(([name, child]) => {
          const expression = zodOf(child, resolve, depth + 1);
          return `${propertyKey(name)}: ${required.has(name) ? expression : `${expression}.optional()`}`;
        });
      return `z.object({${fields.length === 0 ? '' : ` ${fields.join(', ')} `}})`;
    }
    default:
      return 'z.unknown()';
  }
}

function valibotOf(
  schema: JsonSchema,
  resolve: Resolve,
  depth: number,
): string {
  const node = resolve(schema);
  const values = literalEnum(node);
  if (values !== undefined) {
    return `v.picklist(${JSON.stringify(values)})`;
  }
  const type = depth > MAX_DEPTH ? undefined : schemaType(node);
  if (type === undefined) {
    return 'v.unknown()';
  }
  switch (type) {
    case 'string':
      return 'v.string()';
    case 'number':
      return 'v.number()';
    case 'integer':
      return 'v.pipe(v.number(), v.integer())';
    case 'boolean':
      return 'v.boolean()';
    case 'array':
      return `v.array(${isRecord(node.items) ? valibotOf(node.items, resolve, depth + 1) : 'v.unknown()'})`;
    case 'object': {
      const required = new Set(
        Array.isArray(node.required) ? node.required : [],
      );
      const properties = isRecord(node.properties) ? node.properties : {};
      const fields = Object.entries(properties)
        .filter((entry): entry is [string, JsonSchema] => isRecord(entry[1]))
        .map(([name, child]) => {
          const expression = valibotOf(child, resolve, depth + 1);
          return `${propertyKey(name)}: ${required.has(name) ? expression : `v.optional(${expression})`}`;
        });
      return `v.object({${fields.length === 0 ? '' : ` ${fields.join(', ')} `}})`;
    }
    default:
      return 'v.unknown()';
  }
}

/** An arktype definition: a string keyword or an object literal. */
function arktypeOf(
  schema: JsonSchema,
  resolve: Resolve,
  depth: number,
): string {
  const node = resolve(schema);
  const values = literalEnum(node);
  if (values !== undefined) {
    return JSON.stringify(
      values.map((value) => `'${value.replaceAll("'", "\\'")}'`).join(' | '),
    );
  }
  const type = depth > MAX_DEPTH ? undefined : schemaType(node);
  if (type === undefined) {
    return "'unknown'";
  }
  switch (type) {
    case 'string':
      return "'string'";
    case 'number':
      return "'number'";
    case 'integer':
      return "'number.integer'";
    case 'boolean':
      return "'boolean'";
    case 'array': {
      if (!isRecord(node.items)) {
        return "'unknown[]'";
      }
      const item = arktypeOf(node.items, resolve, depth + 1);
      return item.startsWith("'") && !item.includes('|')
        ? `'${item.slice(1, -1)}[]'`
        : `[${item}, '[]']`;
    }
    case 'object': {
      const required = new Set(
        Array.isArray(node.required) ? node.required : [],
      );
      const properties = isRecord(node.properties) ? node.properties : {};
      const fields = Object.entries(properties)
        .filter((entry): entry is [string, JsonSchema] => isRecord(entry[1]))
        .map(
          ([name, child]) =>
            `${JSON.stringify(required.has(name) ? name : `${name}?`)}: ${arktypeOf(child, resolve, depth + 1)}`,
        );
      return `{${fields.length === 0 ? '' : ` ${fields.join(', ')} `}}`;
    }
    default:
      return "'unknown'";
  }
}

/**
 * A validator expression for a JSON Schema object. Only the portable core
 * (primitives, enums of strings, arrays, objects with `required`) is
 * translated; anything else becomes the validator's `unknown`.
 */
export function schemaExpression(
  kind: SchemaKind,
  schema: JsonSchema,
  resolve: Resolve = (node) => node,
): string {
  switch (kind) {
    case 'zod':
      return zodOf(schema, resolve, 0);
    case 'valibot':
      return valibotOf(schema, resolve, 0);
    case 'arktype': {
      const definition = arktypeOf(schema, resolve, 0);
      return `type(${definition})`;
    }
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

function renderList(
  value: GeneratedResource['actions'],
  indent: string,
): string {
  if (Array.isArray(value)) {
    return JSON.stringify(value);
  }
  return JSON.stringify(value, null, 2).replaceAll('\n', `\n${indent}`);
}

function renderResource(resource: GeneratedResource, indent: string): string {
  const inner = `${indent}  `;
  const options = [
    `${inner}id: '${(resource.id ?? 'id').replaceAll('\\', '\\\\').replaceAll("'", "\\'")}',`,
    `${inner}actions: ${renderList(resource.actions, inner)},`,
    `${inner}collection: ${renderList(resource.collection, inner)},`,
  ].join('\n');
  const head =
    resource.schema === undefined
      ? 'resource({'
      : `resource(${resource.schema}, {`;
  return `${head}\n${options}\n${indent}})`;
}

type Trie = Map<string, Trie | GeneratedResource>;

function insert(trie: Trie, resource: GeneratedResource): void {
  let node = trie;
  for (const [index, segment] of resource.path.entries()) {
    if (index === resource.path.length - 1) {
      node.set(segment, resource);
      return;
    }
    const next = node.get(segment);
    if (next instanceof Map) {
      node = next;
    } else {
      const created: Trie = new Map();
      node.set(segment, created);
      node = created;
    }
  }
}

function renderTrie(trie: Trie, indent: string): string {
  return [...trie.entries()]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([segment, value]) =>
      value instanceof Map
        ? `${indent}${propertyKey(segment)}: {\n${renderTrie(value, `${indent}  `)}\n${indent}},`
        : `${indent}${propertyKey(segment)}: ${renderResource(value, indent)},`,
    )
    .join('\n');
}

/** A deterministic `definePermissions()` module with a `// @generated` header. */
export function emitPermissionsModule(input: {
  readonly generator: string;
  readonly schema: SchemaKind | undefined;
  readonly resources: readonly GeneratedResource[];
  /** Extra `export const` declarations written between the imports and `permissions`. */
  readonly exports?: Readonly<Record<string, unknown>>;
}): string {
  const trie: Trie = new Map();
  for (const resource of input.resources) {
    insert(trie, resource);
  }
  const imports = [
    "import { definePermissions, resource } from 'permdock'",
    ...(input.schema === undefined ? [] : [schemaImport(input.schema)]),
  ];
  const extras = Object.entries(input.exports ?? {}).map(
    ([name, value]) =>
      `export const ${name} = ${JSON.stringify(value, null, 2)} as const\n\n`,
  );
  return `// @generated by permdock ${input.generator}
${imports.join('\n')}

${extras.join('')}export const permissions = definePermissions({
${renderTrie(trie, '  ')}
})
`;
}
