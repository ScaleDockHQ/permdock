import type { JsonSchema, SchemaKind } from "../generate.ts";
import type { GenModel, GenResource } from "./model.ts";

import { isRecord } from "../../core/compact.ts";
import { schemaExpression } from "../generate.ts";
import { pascalCase } from "./model.ts";

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;
const MAX_DEPTH = 6;

const FIELD_BOUNDS = [
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
] as const;

type Typed = GenResource & { readonly schema: JsonSchema };

function typed(model: GenModel): readonly Typed[] {
  return model.resources.filter(
    (resource): resource is Typed => resource.schema !== undefined,
  );
}

function propertyKey(name: string): string {
  return IDENTIFIER.test(name) ? name : JSON.stringify(name);
}

/** `createdAt` and `created_at` read as `Created at`. */
function labelOf(name: string): string {
  const words = name
    .replaceAll(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .split(/[^A-Za-z0-9]+/u)
    .filter((word) => word !== "")
    .map((word) => word.toLowerCase());
  const sentence = words.join(" ");
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}`;
}

function properties(
  schema: JsonSchema,
): readonly (readonly [string, JsonSchema, boolean])[] {
  const required = new Set(
    Array.isArray(schema["required"]) ? schema["required"] : [],
  );
  const props = isRecord(schema["properties"]) ? schema["properties"] : {};
  return Object.entries(props)
    .filter((entry): entry is [string, JsonSchema] => isRecord(entry[1]))
    .map(([name, child]) => [name, child, required.has(name)] as const);
}

/** Per field: label, required, enum options, format and bounds, for forms. */
function fieldMeta(schema: JsonSchema): Record<string, unknown> {
  return Object.fromEntries(
    properties(schema).map(([name, child, required]) => {
      const title = child["title"];
      const options = child["enum"];
      const format = child["format"];
      const meta: Record<string, unknown> = {
        label: typeof title === "string" ? title : labelOf(name),
        required,
      };
      const type = child["type"];
      if (Array.isArray(type) && type.includes("null")) {
        meta["nullable"] = true;
      }
      if (Array.isArray(options)) {
        meta["options"] = options.filter((option) => option !== null);
      }
      if (typeof format === "string") {
        meta["format"] = format;
      }
      for (const key of FIELD_BOUNDS) {
        const value = child[key];
        if (typeof value === "number") {
          meta[key] = value;
        }
      }
      return [name, meta];
    }),
  );
}

/**
 * `fields`: per resource the label, requiredness, options and bounds, for
 * forms.
 */
export function fieldsModule(model: GenModel, header: string): string {
  const blocks = typed(model).map(
    (resource) =>
      `export const ${resource.ident}Fields = ${JSON.stringify(fieldMeta(resource.schema), null, 2)} as const;`,
  );
  return `${[header, ...blocks].join("\n\n")}\n`;
}

/** `types`: one row type per resource with a schema; erased at runtime. */
export function typesModule(model: GenModel, header: string): string {
  const blocks = typed(model).map(
    (resource) =>
      `export type ${pascalCase(resource.name)}Row = ${typeOf(resource.schema)};`,
  );
  return `${[header, ...blocks].join("\n\n")}\n`;
}

const IMPORTS: Readonly<Record<SchemaKind, string>> = {
  zod: 'import { z } from "zod";',
  valibot: 'import * as v from "valibot";',
  arktype: 'import { type } from "arktype";',
};

const ENUM_LITERAL: Readonly<Record<SchemaKind, RegExp | undefined>> = {
  zod: /\/\* @__PURE__ \*\/ z\.enum\(\[(?:"(?:[^"\\]|\\.)*",?)*\]\)/gu,
  valibot: /\/\* @__PURE__ \*\/ v\.picklist\(\[(?:"(?:[^"\\]|\\.)*",?)*\]\)/gu,
  arktype: undefined,
};

/**
 * Enum literals used more than once become one `const` above the schemas, so
 * the literal ships once.
 */
function hoisted(
  kind: SchemaKind,
  expressions: readonly string[],
): { readonly consts: readonly string[]; readonly bodies: readonly string[] } {
  const pattern = ENUM_LITERAL[kind];
  if (pattern === undefined) {
    return { consts: [], bodies: expressions };
  }
  const counts = new Map<string, number>();
  for (const expression of expressions) {
    for (const match of expression.matchAll(pattern)) {
      counts.set(match[0], (counts.get(match[0]) ?? 0) + 1);
    }
  }
  const names = new Map<string, string>();
  for (const [literal, count] of counts) {
    if (count > 1) {
      names.set(literal, `values${String(names.size + 1)}`);
    }
  }
  return {
    consts: [...names].map(([literal, name]) => `const ${name} = ${literal};`),
    bodies: expressions.map((expression) =>
      expression.replaceAll(
        pattern,
        (literal) => names.get(literal) ?? literal,
      ),
    ),
  };
}

function arrayOf(kind: SchemaKind, ident: string): string {
  switch (kind) {
    case "zod":
      return `/* @__PURE__ */ z.array(${ident})`;
    case "valibot":
      return `/* @__PURE__ */ v.array(${ident})`;
    case "arktype":
      return `/* @__PURE__ */ ${ident}.array()`;
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

function resultsOf(model: GenModel): readonly (readonly [string, Typed])[] {
  const byName = new Map(
    typed(model).map((resource) => [resource.name, resource]),
  );
  return model.operations.flatMap((operation) => {
    const resource =
      operation.results === undefined
        ? undefined
        : byName.get(operation.results);
    return resource === undefined ? [] : [[operation.ident, resource] as const];
  });
}

export type ValidatorOptions = {
  readonly header: string;
  /** `zod/mini` for the functional, tree-shakeable Zod API; default `zod`. */
  readonly zodSpecifier?: "zod" | "zod/mini";
};

/**
 * `zod`, `valibot` or `arktype`: a row schema per resource and a result schema
 * per operation. Row types live in `types.ts`; fields metadata in `fields.ts`.
 */
export function validatorModule(
  kind: SchemaKind,
  model: GenModel,
  options: ValidatorOptions,
): string {
  const mini = kind === "zod" && options.zodSpecifier === "zod/mini";
  const rows = typed(model);
  const { consts, bodies } = hoisted(
    kind,
    rows.map((resource) =>
      schemaExpression(kind, resource.schema, undefined, {
        constraints: true,
        pure: true,
        zodMini: mini,
      }),
    ),
  );
  const blocks = rows.map(
    (resource, index) =>
      `export const ${resource.ident}Row = ${bodies[index]};`,
  );
  const results = resultsOf(model).map(
    ([operation, resource]) =>
      `export const ${operation}Result = ${arrayOf(kind, `${resource.ident}Row`)};`,
  );
  const imports = mini ? 'import * as z from "zod/mini";' : IMPORTS[kind];
  return `${[options.header, imports, ...consts, ...blocks, ...results].join("\n\n")}\n`;
}

function literalType(value: unknown): string {
  return value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
    ? JSON.stringify(value)
    : "unknown";
}

/** A TypeScript type for the portable JSON Schema core. */
export function typeOf(schema: JsonSchema, depth = 0): string {
  const values = schema["enum"];
  if (Array.isArray(values) && values.length > 0) {
    return values.map(literalType).join(" | ");
  }
  const raw = schema["type"];
  const types: readonly unknown[] = Array.isArray(raw) ? raw : [raw];
  const nullable = types.includes("null");
  const named = types.filter(
    (type) => typeof type === "string" && type !== "null",
  );
  const base =
    depth > MAX_DEPTH || named.length !== 1
      ? isRecord(schema["properties"]) && named.length === 0
        ? objectType(schema, depth)
        : "unknown"
      : primitiveType(schema, named[0], depth);
  return nullable && base !== "unknown" ? `${base} | null` : base;
}

function objectType(schema: JsonSchema, depth: number): string {
  const fields = properties(schema).map(
    ([name, child, required]) =>
      `readonly ${propertyKey(name)}${required ? "" : "?"}: ${typeOf(child, depth + 1)}`,
  );
  return fields.length === 0 ? "{}" : `{ ${fields.join("; ")} }`;
}

function primitiveType(
  schema: JsonSchema,
  type: unknown,
  depth: number,
): string {
  switch (type) {
    case "string":
      return "string";
    case "number":
    case "integer":
      return "number";
    case "boolean":
      return "boolean";
    case "array":
      return `readonly (${isRecord(schema["items"]) ? typeOf(schema["items"], depth + 1) : "unknown"})[]`;
    case "object":
      return objectType(schema, depth);
    default:
      return "unknown";
  }
}

/**
 * Drops `$schema`. The `pattern` that sits next to a `format` stays:
 * `resourceSchemaFromJson` accepts `format` only with the `pattern` that
 * enforces it, and `literals` ships each distinct pattern once.
 */
function withoutNoise(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(withoutNoise);
  }
  if (!isRecord(value)) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "$schema")
      .map(([key, child]) => [key, withoutNoise(child)]),
  );
}

const HOIST_FROM = 60;

/**
 * JavaScript text for JSON values where a sub-object or string that repeats and
 * is long enough becomes one `const`, so a regex or enum list ships once.
 */
function literals(values: readonly unknown[]): {
  readonly consts: readonly string[];
  readonly texts: readonly string[];
} {
  const counts = new Map<string, number>();
  const count = (value: unknown, top: boolean): void => {
    if (Array.isArray(value)) {
      for (const item of value) {
        count(item, false);
      }
    } else if (typeof value === "string") {
      if (value.length >= HOIST_FROM) {
        const text = JSON.stringify(value);
        counts.set(text, (counts.get(text) ?? 0) + 1);
      }
    } else if (isRecord(value)) {
      if (!top) {
        const text = JSON.stringify(value);
        counts.set(text, (counts.get(text) ?? 0) + 1);
      }
      for (const child of Object.values(value)) {
        count(child, false);
      }
    }
  };
  for (const value of values) {
    count(value, true);
  }
  const names = new Map<string, string>();
  const consts: string[] = [];
  const write = (value: unknown, top: boolean): string => {
    if (Array.isArray(value)) {
      return `[${value.map((item) => write(item, false)).join(",")}]`;
    }
    if (!isRecord(value)) {
      return JSON.stringify(value);
    }
    const key = JSON.stringify(value);
    const repeated =
      !top && key.length >= HOIST_FROM && (counts.get(key) ?? 0) > 1;
    const known = repeated ? names.get(key) : undefined;
    if (known !== undefined) {
      return known;
    }
    const body = `{${Object.entries(value)
      .map(([name, child]) => `${JSON.stringify(name)}:${write(child, false)}`)
      .join(",")}}`;
    if (!repeated) {
      return body;
    }
    const name = `shape${String(names.size + 1)}`;
    names.set(key, name);
    consts.push(`const ${name} = ${body};`);
    return name;
  };
  const texts = values.map((value) => write(value, true));
  return { consts, texts };
}

/**
 * `standard-schema`: validators over the JSON Schema core through
 * `permdock/catalog`, so the project needs no schema library.
 */
export function standardSchemaModule(
  model: GenModel,
  options: { readonly header: string },
): string {
  const rows = typed(model);
  const operations = resultsOf(model);
  const { consts, texts } = literals([
    ...rows.map((resource) => withoutNoise(resource.schema)),
    ...operations.map(([, resource]) =>
      withoutNoise({ type: "array", items: resource.schema }),
    ),
  ]);
  const blocks = rows.map(
    (resource, index) =>
      `export const ${resource.ident}Row = /* @__PURE__ */ resourceSchemaFromJson(${texts[index]});`,
  );
  const results = operations.map(
    ([operation], index) =>
      `export const ${operation}Result = /* @__PURE__ */ resourceSchemaFromJson(${texts[rows.length + index]});`,
  );
  return `${[options.header, 'import { resourceSchemaFromJson } from "permdock/catalog";', ...consts, ...blocks, ...results].join("\n\n")}\n`;
}

/** `json-schema`: the row documents as they are, results as `$ref` arrays. */
export function jsonSchemaDocument(model: GenModel, header: string): string {
  const document = {
    $comment: header.replace(/^\/\/ /u, ""),
    resources: Object.fromEntries(
      typed(model).map((resource) => [resource.name, resource.schema]),
    ),
    operations: Object.fromEntries(
      resultsOf(model).map(([operation, resource]) => [
        operation,
        {
          results: {
            type: "array",
            items: {
              $ref: `#/resources/${resource.name.replaceAll("~", "~0").replaceAll("/", "~1")}`,
            },
          },
        },
      ]),
    ),
  };
  return `${JSON.stringify(document, null, 2)}\n`;
}
