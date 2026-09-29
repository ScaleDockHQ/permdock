import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { isMap, parseDocument } from 'yaml';

import type {
  GeneratedAction,
  GeneratedResource,
  JsonSchema,
  SchemaKind,
} from './generate.ts';
import type { CliIo } from './types.ts';

import { emitPermissionsModule, schemaExpression } from './generate.ts';
import { validateOpenapi } from './openapi-schema.ts';

const METHODS = [
  'get',
  'put',
  'post',
  'delete',
  'options',
  'head',
  'patch',
  'trace',
  'query',
] as const;

const UNSAFE_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);
const SEGMENT = /^[A-Za-z_$][A-Za-z0-9_$-]*$/u;

type Operation = {
  readonly method: string;
  readonly path: string;
  readonly node: Record<string, unknown>;
};

type Inferred = {
  readonly key: string;
  readonly kind: 'instance' | 'collection';
  readonly meta: GeneratedAction;
  readonly schema?: JsonSchema;
};

type ResourceEntry = {
  readonly path: readonly string[];
  readonly actions: Map<
    string,
    { meta: GeneratedAction; instance: boolean; from: string[] }
  >;
  schema?: JsonSchema;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function operations(document: Record<string, unknown>): readonly Operation[] {
  const paths = isRecord(document.paths) ? document.paths : {};
  const out: Operation[] = [];
  for (const [path, item] of Object.entries(paths)) {
    if (!isRecord(item)) {
      continue;
    }
    for (const method of METHODS) {
      const node = item[method];
      if (isRecord(node)) {
        out.push({ method, path, node });
      }
    }
  }
  return out;
}

function segments(path: string): readonly string[] {
  return path.split('/').filter((segment) => segment !== '');
}

function isParam(segment: string): boolean {
  return segment.startsWith('{') && segment.endsWith('}');
}

function identifier(value: string): string {
  const cleaned = value
    .replaceAll(/[^A-Za-z0-9]+(.)?/gu, (_, next: string | undefined) =>
      next === undefined ? '' : next.toUpperCase(),
    )
    .replace(/^[0-9]+/u, '');
  const head = cleaned.charAt(0).toLowerCase() + cleaned.slice(1);
  return head === '' || UNSAFE_SEGMENTS.has(head) ? '' : head;
}

function arity(path: string, resource: string): 'instance' | 'collection' {
  const parts = segments(path);
  const at = parts.findIndex(
    (segment) => !isParam(segment) && identifier(segment) === resource,
  );
  const after = at === -1 ? parts : parts.slice(at + 1);
  return after.some(isParam) ? 'instance' : 'collection';
}

function oauthSchemes(document: Record<string, unknown>): ReadonlySet<string> {
  const components = isRecord(document.components) ? document.components : {};
  const schemes = isRecord(components.securitySchemes)
    ? components.securitySchemes
    : {};
  return new Set(
    Object.entries(schemes)
      .filter(
        ([, scheme]) =>
          isRecord(scheme) &&
          (scheme.type === 'oauth2' || scheme.type === 'openIdConnect'),
      )
      .map(([name]) => name),
  );
}

function scopesOf(
  requirements: unknown,
  schemes: ReadonlySet<string>,
): readonly string[] {
  if (!Array.isArray(requirements)) {
    return [];
  }
  const scopes: string[] = [];
  for (const requirement of requirements) {
    if (!isRecord(requirement)) {
      continue;
    }
    for (const [name, values] of Object.entries(requirement)) {
      if (schemes.has(name) && Array.isArray(values)) {
        scopes.push(
          ...values.filter(
            (value): value is string => typeof value === 'string',
          ),
        );
      }
    }
  }
  return scopes;
}

function defaultAction(method: string, kind: 'instance' | 'collection') {
  switch (method) {
    case 'get':
    case 'head':
    case 'query':
      return kind === 'instance' ? 'read' : 'list';
    case 'post':
      return kind === 'instance' ? 'update' : 'create';
    case 'put':
    case 'patch':
      return 'update';
    case 'delete':
      return 'delete';
    default:
      return method;
  }
}

function validKey(key: string): boolean {
  const parts = key.split('.');
  return (
    parts.length >= 2 &&
    parts.every((part) => SEGMENT.test(part) && !UNSAFE_SEGMENTS.has(part))
  );
}

function jsonSchemaOf(node: unknown): JsonSchema | undefined {
  if (!isRecord(node) || !isRecord(node.content)) {
    return undefined;
  }
  for (const [type, media] of Object.entries(node.content)) {
    if (
      /json/u.test(type) &&
      isRecord(media) &&
      isRecord(media.schema) &&
      typeof media.schema.$ref === 'string'
    ) {
      return media.schema;
    }
  }
  return undefined;
}

function resourceSchemaOf(operation: Operation): JsonSchema | undefined {
  const responses = isRecord(operation.node.responses)
    ? operation.node.responses
    : {};
  const ok = responses['200'] ?? responses['201'];
  return jsonSchemaOf(ok) ?? jsonSchemaOf(operation.node.requestBody);
}

function refResolver(document: Record<string, unknown>) {
  return (schema: JsonSchema): JsonSchema => {
    let node = schema;
    for (let hop = 0; hop < 8 && typeof node.$ref === 'string'; hop += 1) {
      const match = /^#\/components\/schemas\/([^/]+)$/u.exec(node.$ref);
      const components = isRecord(document.components)
        ? document.components
        : {};
      const schemas = isRecord(components.schemas) ? components.schemas : {};
      const name = match?.[1];
      const next =
        name === undefined || UNSAFE_SEGMENTS.has(name)
          ? undefined
          : schemas[name];
      if (!isRecord(next)) {
        return {};
      }
      node = next;
    }
    return node;
  };
}

function metaFor(operation: Operation, inferred: string): GeneratedAction {
  const summary = operation.node.summary;
  const description = operation.node.description;
  const tags = Array.isArray(operation.node.tags)
    ? operation.node.tags.filter(
        (tag): tag is string => typeof tag === 'string',
      )
    : [];
  const meta: {
    title?: string;
    description?: string;
    tags?: readonly string[];
    readOnly?: boolean;
    inferredFrom: string;
  } = { inferredFrom: inferred };
  if (typeof summary === 'string') {
    meta.title = summary;
  }
  if (typeof description === 'string') {
    meta.description = description;
  }
  if (tags.length > 0) {
    meta.tags = tags;
  }
  if (['get', 'head', 'query'].includes(operation.method)) {
    meta.readOnly = true;
  }
  return meta;
}

function inferOperation(
  operation: Operation,
  document: Record<string, unknown>,
  schemes: ReadonlySet<string>,
  map: Readonly<Record<string, string>>,
): { readonly keys: readonly Inferred[]; readonly error?: string } {
  const label = `${operation.method.toUpperCase()} ${operation.path}`;
  const explicit = operation.node['x-permdock-permissions'];
  const mapped = map[label];
  let keys: readonly string[];
  if (mapped !== undefined) {
    keys = [mapped];
  } else if (Array.isArray(explicit)) {
    keys = explicit.filter((key): key is string => typeof key === 'string');
  } else {
    const scopes = scopesOf(
      operation.node.security ?? document.security,
      schemes,
    );
    if (scopes.length > 0) {
      keys = scopes.map((scope) => scope.replaceAll(':', '.'));
    } else {
      const tag = Array.isArray(operation.node.tags)
        ? operation.node.tags.find(
            (item): item is string => typeof item === 'string',
          )
        : undefined;
      const segment = segments(operation.path).find((part) => !isParam(part));
      const resource = identifier(tag ?? segment ?? '');
      if (resource === '') {
        return {
          keys: [],
          error: `${label}: cannot name a resource; add it to --map`,
        };
      }
      const kind = arity(operation.path, resource);
      const action =
        typeof operation.node.operationId === 'string'
          ? identifier(operation.node.operationId)
          : defaultAction(operation.method, kind);
      keys = [`${resource}.${action}`];
    }
  }
  const out: Inferred[] = [];
  for (const key of keys) {
    if (!validKey(key)) {
      return { keys: [], error: `${label}: '${key}' is not a permission key` };
    }
    const resource = key.split('.').at(-2) ?? '';
    const schema = resourceSchemaOf(operation);
    out.push({
      key,
      kind: arity(operation.path, resource),
      meta: metaFor(operation, label),
      ...(schema === undefined ? {} : { schema }),
    });
  }
  return { keys: out };
}

function readMap(
  cwd: string,
  file: string | undefined,
): Readonly<Record<string, string>> | string {
  if (file === undefined) {
    return {};
  }
  const path = resolve(cwd, file);
  if (!existsSync(path)) {
    return `--map file not found: ${file}`;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return '--map must be a JSON object';
  }
  if (!isRecord(parsed)) {
    return '--map must be a JSON object';
  }
  const map: Record<string, string> = {};
  for (const [label, key] of Object.entries(parsed)) {
    if (typeof key !== 'string' || !/^[A-Z]+ \//u.test(label)) {
      return `--map entries are "METHOD /path": "resource.action" (got '${label}')`;
    }
    map[label] = key;
  }
  return map;
}

async function readSource(
  cwd: string,
  doc: string,
  io: CliIo,
): Promise<{ readonly text: string; readonly local?: string } | string> {
  if (/^https?:\/\//u.test(doc)) {
    const fetcher = io.fetch ?? globalThis.fetch;
    try {
      const response = await fetcher(doc);
      if (!response.ok) {
        return `could not fetch ${doc}: HTTP ${response.status}`;
      }
      return { text: await response.text() };
    } catch {
      return `could not fetch ${doc}`;
    }
  }
  const path = resolve(cwd, doc);
  if (!existsSync(path)) {
    return `document not found: ${doc}`;
  }
  return { text: readFileSync(path, 'utf8'), local: path };
}

function parseSource(
  text: string,
): { readonly value: unknown; readonly yaml: boolean } | undefined {
  try {
    return { value: JSON.parse(text), yaml: false };
  } catch {
    // Not JSON; OpenAPI documents are YAML just as often.
  }
  const parsed = parseDocument(text, { uniqueKeys: true });
  if (parsed.errors.length > 0 || !isMap(parsed.contents)) {
    return undefined;
  }
  return { value: parsed.toJS({ maxAliasCount: 50 }), yaml: true };
}

function annotated(
  text: string,
  yaml: boolean,
  value: Record<string, unknown>,
  permissions: ReadonlyMap<Operation, readonly string[]>,
): string {
  if (yaml) {
    const document = parseDocument(text);
    for (const [operation, keys] of permissions) {
      document.setIn(
        ['paths', operation.path, operation.method, 'x-permdock-permissions'],
        [...keys],
      );
    }
    return document.toString();
  }
  for (const [operation, keys] of permissions) {
    operation.node['x-permdock-permissions'] = [...keys];
  }
  return `${JSON.stringify(value, null, 2)}\n`;
}

export async function runOpenapiImport(input: {
  readonly cwd: string;
  readonly doc: string;
  readonly out: string | undefined;
  readonly schema: SchemaKind | undefined;
  readonly map: string | undefined;
  readonly annotate: boolean;
  readonly io: CliIo;
}): Promise<{ readonly code: 0 | 1 | 2; readonly output: string }> {
  if (input.out === undefined) {
    return { code: 2, output: 'openapi import needs --out <file>' };
  }
  const map = readMap(input.cwd, input.map);
  if (typeof map === 'string') {
    return { code: 2, output: `PermDock CLI: ${map}` };
  }
  const source = await readSource(input.cwd, input.doc, input.io);
  if (typeof source === 'string') {
    return { code: 2, output: `PermDock CLI: ${source}` };
  }
  if (input.annotate && source.local === undefined) {
    return {
      code: 2,
      output: 'PermDock CLI: --annotate needs a local --doc file',
    };
  }
  const parsed = parseSource(source.text);
  if (parsed === undefined || !isRecord(parsed.value)) {
    return {
      code: 2,
      output: 'PermDock CLI: --doc must be a JSON or YAML OpenAPI document',
    };
  }
  const document = parsed.value;
  const valid = validateOpenapi(document);
  if (!valid.ok) {
    return { code: 2, output: `PermDock CLI: ${valid.error}` };
  }
  const schemes = oauthSchemes(document);
  const resolveRef = refResolver(document);
  const byResource = new Map<string, ResourceEntry>();
  const permissions = new Map<Operation, readonly string[]>();
  const errors: string[] = [];
  for (const operation of operations(document)) {
    const result = inferOperation(operation, document, schemes, map);
    if (result.error !== undefined) {
      errors.push(result.error);
      continue;
    }
    permissions.set(
      operation,
      result.keys.map((item) => item.key),
    );
    for (const item of result.keys) {
      const parts = item.key.split('.');
      const action = parts.at(-1) ?? '';
      const path = parts.slice(0, -1);
      const id = path.join('.');
      const entry: ResourceEntry = byResource.get(id) ?? {
        path,
        actions: new Map(),
      };
      byResource.set(id, entry);
      if (entry.schema === undefined && item.schema !== undefined) {
        entry.schema = item.schema;
      }
      const seen = entry.actions.get(action);
      const from = item.meta.inferredFrom ?? '';
      if (seen === undefined) {
        entry.actions.set(action, {
          meta: item.meta,
          instance: item.kind === 'instance',
          from: [from],
        });
      } else {
        seen.instance ||= item.kind === 'instance';
        seen.from.push(from);
      }
    }
  }
  if (errors.length > 0) {
    return { code: 1, output: errors.join('\n') };
  }
  const listOf = (
    actions: ResourceEntry['actions'],
    instance: boolean,
  ): Record<string, GeneratedAction> =>
    Object.fromEntries(
      [...actions.entries()]
        .filter(([, value]) => value.instance === instance)
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([name, value]) => [
          name,
          { ...value.meta, inferredFrom: value.from.join(', ') },
        ]),
    );
  const resources: GeneratedResource[] = [...byResource.values()].map(
    (entry) => {
      const resource: GeneratedResource = {
        path: entry.path,
        actions: listOf(entry.actions, true),
        collection: listOf(entry.actions, false),
      };
      return input.schema === undefined
        ? resource
        : Object.assign(resource, {
            schema: schemaExpression(
              input.schema,
              entry.schema ?? { type: 'object' },
              resolveRef,
            ),
          });
    },
  );
  const outPath = resolve(input.cwd, input.out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(
    outPath,
    emitPermissionsModule({
      generator: 'openapi import',
      schema: input.schema,
      resources,
    }),
  );
  if (input.annotate && source.local !== undefined) {
    writeFileSync(
      source.local,
      annotated(source.text, parsed.yaml, document, permissions),
    );
  }
  const leaves = resources.reduce(
    (total, item) =>
      total +
      Object.keys(item.actions).length +
      Object.keys(item.collection).length,
    0,
  );
  return {
    code: 0,
    output: `wrote ${input.out} (${resources.length} resources, ${leaves} permissions)${input.annotate ? `; annotated ${input.doc}` : ''}`,
  };
}
