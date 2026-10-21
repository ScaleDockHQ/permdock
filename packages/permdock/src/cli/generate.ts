import { isRecord } from "../core/compact.ts";
import { byCodePoint } from "../core/compare.ts";

export type SchemaKind = "zod" | "valibot" | "arktype";

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
  /**
   * A validator expression from `schemaExpression`; omitted for a schema-less
   * resource.
   */
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
  return value === "zod" || value === "valibot" || value === "arktype";
}

function schemaImport(kind: SchemaKind): string {
  switch (kind) {
    case "zod":
      return "import { z } from 'zod'";
    case "valibot":
      return "import * as v from 'valibot'";
    case "arktype":
      return "import { type } from 'arktype'";
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

export function emptySchema(kind: SchemaKind): string {
  return schemaExpression(kind, { type: "object" });
}

function propertyKey(name: string): string {
  return IDENTIFIER.test(name) ? name : JSON.stringify(name);
}

function literalEnum(schema: JsonSchema): readonly string[] | undefined {
  const type = schema["type"];
  const nullable = Array.isArray(type) && type.includes("null");
  const all = schema["enum"];
  const values =
    nullable && Array.isArray(all)
      ? all.filter((value) => value !== null)
      : all;
  if (
    !Array.isArray(values) ||
    values.length === 0 ||
    !values.every((value): value is string => typeof value === "string")
  ) {
    return undefined;
  }
  return values;
}

function schemaType(schema: JsonSchema): string | undefined {
  const type = schema["type"];
  if (typeof type === "string") {
    return type;
  }
  if (Array.isArray(type)) {
    const named = type.filter((item) => item !== "null");
    return named.length === 1 && typeof named[0] === "string"
      ? named[0]
      : undefined;
  }
  return isRecord(schema["properties"]) ? "object" : undefined;
}

type Resolve = (schema: JsonSchema) => JsonSchema;

export type SchemaExpressionOptions = {
  /**
   * Also translate `format` (`uuid`, `email`, `uri`, `date-time`, `date`), the
   * `minimum` / `maximum` / `minLength` / `maxLength` / `minItems` / `maxItems`
   * bounds and a `null` member of `type`.
   */
  readonly constraints?: boolean;
};

type Emit = { readonly resolve: Resolve; readonly constraints: boolean };

function bound(node: JsonSchema, key: string): number | undefined {
  const value = node[key];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function isNullable(node: JsonSchema, emit: Emit): boolean {
  const type = node["type"];
  return emit.constraints && Array.isArray(type) && type.includes("null");
}

function formatOf(node: JsonSchema, emit: Emit): string | undefined {
  const format = node["format"];
  return emit.constraints && typeof format === "string" ? format : undefined;
}

/** `[method, value]` pairs for the bounds `keys` names, in order. */
function bounds(
  node: JsonSchema,
  emit: Emit,
  keys: readonly (readonly [string, string])[],
): readonly (readonly [string, number])[] {
  if (!emit.constraints) {
    return [];
  }
  return keys.flatMap(([key, method]) => {
    const value = bound(node, key);
    return value === undefined ? [] : [[method, value] as const];
  });
}

const NUMBER_BOUNDS = [
  ["minimum", "min"],
  ["exclusiveMinimum", "gt"],
  ["maximum", "max"],
  ["exclusiveMaximum", "lt"],
] as const;
const LENGTH_BOUNDS = [
  ["minLength", "min"],
  ["maxLength", "max"],
] as const;
const ITEM_BOUNDS = [
  ["minItems", "min"],
  ["maxItems", "max"],
] as const;

const ZOD_FORMATS: Readonly<Record<string, string>> = {
  uuid: "z.uuid()",
  email: "z.email()",
  uri: "z.url()",
  "date-time": "z.iso.datetime({ offset: true })",
  date: "z.iso.date()",
};

function zodChain(
  base: string,
  pairs: readonly (readonly [string, number])[],
): string {
  return `${base}${pairs.map(([method, value]) => `.${method}(${String(value)})`).join("")}`;
}

function zodOf(schema: JsonSchema, emit: Emit, depth: number): string {
  const node = emit.resolve(schema);
  const expression = zodNode(node, emit, depth);
  return isNullable(node, emit) ? `${expression}.nullable()` : expression;
}

function zodNode(node: JsonSchema, emit: Emit, depth: number): string {
  const values = literalEnum(node);
  if (values !== undefined) {
    return `z.enum(${JSON.stringify(values)})`;
  }
  const type = depth > MAX_DEPTH ? undefined : schemaType(node);
  if (type === undefined) {
    return "z.unknown()";
  }
  switch (type) {
    case "string":
      return zodChain(
        ZOD_FORMATS[formatOf(node, emit) ?? ""] ?? "z.string()",
        bounds(node, emit, LENGTH_BOUNDS),
      );
    case "number":
      return zodChain("z.number()", bounds(node, emit, NUMBER_BOUNDS));
    case "integer":
      return zodChain("z.number().int()", bounds(node, emit, NUMBER_BOUNDS));
    case "boolean":
      return "z.boolean()";
    case "array":
      return zodChain(
        `z.array(${isRecord(node["items"]) ? zodOf(node["items"], emit, depth + 1) : "z.unknown()"})`,
        bounds(node, emit, ITEM_BOUNDS),
      );
    case "object": {
      const fields = objectFields(node).map(([name, child, required]) => {
        const expression = zodOf(child, emit, depth + 1);
        return `${propertyKey(name)}: ${required ? expression : `${expression}.optional()`}`;
      });
      return `z.object({${fields.length === 0 ? "" : ` ${fields.join(", ")} `}})`;
    }
    default:
      return "z.unknown()";
  }
}

/** Each property of an object schema with whether `required` names it. */
function objectFields(
  node: JsonSchema,
): readonly (readonly [string, JsonSchema, boolean])[] {
  const required = new Set(
    Array.isArray(node["required"]) ? node["required"] : [],
  );
  const properties = isRecord(node["properties"]) ? node["properties"] : {};
  return Object.entries(properties)
    .filter((entry): entry is [string, JsonSchema] => isRecord(entry[1]))
    .map(([name, child]) => [name, child, required.has(name)] as const);
}

const VALIBOT_FORMATS: Readonly<Record<string, string>> = {
  uuid: "v.uuid()",
  email: "v.email()",
  uri: "v.url()",
  "date-time": "v.isoTimestamp()",
  date: "v.isoDate()",
};

const VALIBOT_NUMBER_BOUNDS = [
  ["minimum", "minValue"],
  ["exclusiveMinimum", "gtValue"],
  ["maximum", "maxValue"],
  ["exclusiveMaximum", "ltValue"],
] as const;

function valibotPipe(base: string, actions: readonly string[]): string {
  return actions.length === 0
    ? base
    : `v.pipe(${[base, ...actions].join(", ")})`;
}

function valibotLength(
  pairs: readonly (readonly [string, number])[],
): string[] {
  return pairs.map(
    ([method, value]) =>
      `v.${method === "min" ? "minLength" : "maxLength"}(${String(value)})`,
  );
}

function valibotOf(schema: JsonSchema, emit: Emit, depth: number): string {
  const node = emit.resolve(schema);
  const expression = valibotNode(node, emit, depth);
  return isNullable(node, emit) ? `v.nullable(${expression})` : expression;
}

function valibotNode(node: JsonSchema, emit: Emit, depth: number): string {
  const values = literalEnum(node);
  if (values !== undefined) {
    return `v.picklist(${JSON.stringify(values)})`;
  }
  const type = depth > MAX_DEPTH ? undefined : schemaType(node);
  if (type === undefined) {
    return "v.unknown()";
  }
  const numeric = bounds(node, emit, VALIBOT_NUMBER_BOUNDS).map(
    ([method, value]) => `v.${method}(${String(value)})`,
  );
  switch (type) {
    case "string": {
      const format = VALIBOT_FORMATS[formatOf(node, emit) ?? ""];
      return valibotPipe("v.string()", [
        ...(format === undefined ? [] : [format]),
        ...valibotLength(bounds(node, emit, LENGTH_BOUNDS)),
      ]);
    }
    case "number":
      return valibotPipe("v.number()", numeric);
    case "integer":
      return valibotPipe("v.number()", ["v.integer()", ...numeric]);
    case "boolean":
      return "v.boolean()";
    case "array":
      return valibotPipe(
        `v.array(${isRecord(node["items"]) ? valibotOf(node["items"], emit, depth + 1) : "v.unknown()"})`,
        valibotLength(bounds(node, emit, ITEM_BOUNDS)),
      );
    case "object": {
      const fields = objectFields(node).map(([name, child, required]) => {
        const expression = valibotOf(child, emit, depth + 1);
        return `${propertyKey(name)}: ${required ? expression : `v.optional(${expression})`}`;
      });
      return `v.object({${fields.length === 0 ? "" : ` ${fields.join(", ")} `}})`;
    }
    default:
      return "v.unknown()";
  }
}

const ARKTYPE_FORMATS: Readonly<Record<string, string>> = {
  uuid: "string.uuid",
  email: "string.email",
  uri: "string.url",
  "date-time": "string.date.iso",
  date: "string.date.iso",
};

/** `1 <= string <= 120`; arktype bounds apply to `string` and `number` only. */
function arktypeRange(
  keyword: string,
  pairs: readonly (readonly [string, number])[],
): string {
  const lower = pairs.find(([method]) => method === "min" || method === "gt");
  const upper = pairs.find(([method]) => method === "max" || method === "lt");
  const left =
    lower === undefined
      ? ""
      : `${String(lower[1])} ${lower[0] === "gt" ? "<" : "<="} `;
  const right =
    upper === undefined
      ? ""
      : ` ${upper[0] === "lt" ? "<" : "<="} ${String(upper[1])}`;
  return lower !== undefined && upper === undefined
    ? `${keyword} ${lower[0] === "gt" ? ">" : ">="} ${String(lower[1])}`
    : `${left}${keyword}${right}`;
}

/** An arktype definition: a string keyword or an object literal. */
function arktypeOf(schema: JsonSchema, emit: Emit, depth: number): string {
  const node = emit.resolve(schema);
  const definition = arktypeNode(node, emit, depth);
  if (!isNullable(node, emit)) {
    return definition;
  }
  return definition.startsWith("'")
    ? `'${definition.slice(1, -1)} | null'`
    : `[${definition}, '|', 'null']`;
}

function arktypeNode(node: JsonSchema, emit: Emit, depth: number): string {
  const values = literalEnum(node);
  if (values !== undefined) {
    return JSON.stringify(
      values.map((value) => `'${value.replaceAll("'", "\\'")}'`).join(" | "),
    );
  }
  const type = depth > MAX_DEPTH ? undefined : schemaType(node);
  if (type === undefined) {
    return "'unknown'";
  }
  switch (type) {
    case "string": {
      const format = ARKTYPE_FORMATS[formatOf(node, emit) ?? ""];
      return format === undefined
        ? `'${arktypeRange("string", bounds(node, emit, LENGTH_BOUNDS))}'`
        : `'${format}'`;
    }
    case "number":
      return `'${arktypeRange("number", bounds(node, emit, NUMBER_BOUNDS))}'`;
    case "integer":
      return "'number.integer'";
    case "boolean":
      return "'boolean'";
    case "array": {
      if (!isRecord(node["items"])) {
        return "'unknown[]'";
      }
      const item = arktypeOf(node["items"], emit, depth + 1);
      return item.startsWith("'") && !item.includes("|")
        ? `'${item.slice(1, -1)}[]'`
        : `[${item}, '[]']`;
    }
    case "object": {
      const fields = objectFields(node).map(
        ([name, child, required]) =>
          `${JSON.stringify(required ? name : `${name}?`)}: ${arktypeOf(child, emit, depth + 1)}`,
      );
      return `{${fields.length === 0 ? "" : ` ${fields.join(", ")} `}}`;
    }
    default:
      return "'unknown'";
  }
}

/**
 * A validator expression for a JSON Schema object. Only the portable core
 * (primitives, enums of strings, arrays, objects with `required`) is
 * translated, plus with `constraints` the formats, bounds and nullable types;
 * anything else becomes the validator's `unknown`.
 */
export function schemaExpression(
  kind: SchemaKind,
  schema: JsonSchema,
  resolve: Resolve = (node) => node,
  options: SchemaExpressionOptions = {},
): string {
  const emit: Emit = { resolve, constraints: options.constraints === true };
  switch (kind) {
    case "zod":
      return zodOf(schema, emit, 0);
    case "valibot":
      return valibotOf(schema, emit, 0);
    case "arktype": {
      const definition = arktypeOf(schema, emit, 0);
      return `type(${definition})`;
    }
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

function renderList(
  value: GeneratedResource["actions"],
  indent: string,
): string {
  if (Array.isArray(value)) {
    return JSON.stringify(value);
  }
  return JSON.stringify(value, null, 2).replaceAll("\n", `\n${indent}`);
}

function renderResource(resource: GeneratedResource, indent: string): string {
  const inner = `${indent}  `;
  const options = [
    `${inner}id: '${(resource.id ?? "id").replaceAll("\\", "\\\\").replaceAll("'", "\\'")}',`,
    `${inner}actions: ${renderList(resource.actions, inner)},`,
    `${inner}collection: ${renderList(resource.collection, inner)},`,
  ].join("\n");
  const head =
    resource.schema === undefined
      ? "resource({"
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
    .toSorted(([a], [b]) => byCodePoint(a, b))
    .map(([segment, value]) =>
      value instanceof Map
        ? `${indent}${propertyKey(segment)}: {\n${renderTrie(value, `${indent}  `)}\n${indent}},`
        : `${indent}${propertyKey(segment)}: ${renderResource(value, indent)},`,
    )
    .join("\n");
}

/** A deterministic `definePermissions()` module with a `// @generated` header. */
export function emitPermissionsModule(input: {
  readonly generator: string;
  readonly schema: SchemaKind | undefined;
  readonly resources: readonly GeneratedResource[];
  /**
   * Extra `export const` declarations written between the imports and
   * `permissions`.
   */
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
${imports.join("\n")}

${extras.join("")}export const permissions = definePermissions({
${renderTrie(trie, "  ")}
})
`;
}
