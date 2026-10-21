import type { JsonSchema } from "../generate.ts";
import type { GenModel, GenResource } from "./model.ts";

import { isRecord } from "../../core/compact.ts";
import { pascalCase } from "./model.ts";
import { GENERATED, typeOf } from "./schemas.ts";

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;

function key(name: string): string {
  return IDENTIFIER.test(name) ? name : JSON.stringify(name);
}

function number(schema: JsonSchema, name: string): number | undefined {
  const value = schema[name];
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function typeName(schema: JsonSchema): string | undefined {
  const raw = schema["type"];
  const types: readonly unknown[] = Array.isArray(raw) ? raw : [raw];
  const named = types.find(
    (type): type is string => typeof type === "string" && type !== "null",
  );
  return named ?? (isRecord(schema["properties"]) ? "object" : undefined);
}

function numberValue(schema: JsonSchema, integer: boolean): string {
  const step = integer ? 1 : 0.5;
  const exclusive = number(schema, "exclusiveMinimum");
  const minimum =
    number(schema, "minimum") ??
    (exclusive === undefined ? undefined : exclusive + step);
  const maximum = number(schema, "maximum");
  const value = minimum ?? (maximum === undefined ? 0 : Math.min(0, maximum));
  return String(integer ? Math.ceil(value) : value);
}

/**
 * A valid value for a required field: the first enum value, the lower bound, a
 * sequence id.
 */
function valueOf(schema: JsonSchema, field: string, depth: number): string {
  const values = schema["enum"];
  if (Array.isArray(values) && values.length > 0) {
    return JSON.stringify(values[0]);
  }
  switch (typeName(schema)) {
    case "string":
      return stringValue(schema, field);
    case "integer":
      return numberValue(schema, true);
    case "number":
      return numberValue(schema, false);
    case "boolean":
      return "false";
    case "array":
      return "[]";
    case "object":
      return depth > 4 ? "{}" : objectValue(schema, depth + 1, new Map());
    default:
      return "null";
  }
}

function stringValue(schema: JsonSchema, field: string): string {
  switch (schema["format"]) {
    case "uuid":
      return "uuid()";
    case "email":
      return "`user${String(next())}@example.com`";
    case "date-time":
      return '"2026-01-01T00:00:00.000Z"';
    case "date":
      return '"2026-01-01"';
    case "uri":
      return "`https://example.com/${String(next())}`";
    default:
      return `text(${JSON.stringify(field)}, ${String(number(schema, "minLength") ?? 0)}, ${String(number(schema, "maxLength") ?? 255)})`;
  }
}

function objectValue(
  schema: JsonSchema,
  depth: number,
  refs: ReadonlyMap<string, string>,
): string {
  const required = new Set(
    Array.isArray(schema["required"]) ? schema["required"] : [],
  );
  const properties = isRecord(schema["properties"]) ? schema["properties"] : {};
  const fields = Object.entries(properties)
    .filter((entry): entry is [string, JsonSchema] => isRecord(entry[1]))
    .filter(([name]) => required.has(name))
    .map(([name, child]) => {
      const ref = typeName(child) === "string" ? refs.get(name) : undefined;
      const fill = valueOf(child, name, depth);
      return `${key(name)}: ${ref === undefined ? fill : `refs.${ref} === undefined ? ${fill} : idOf(refs.${ref})`}`;
    });
  return fields.length === 0 ? "{}" : `{ ${fields.join(", ")} }`;
}

type Typed = GenResource & { readonly schema: JsonSchema };

function requiredFields(schema: JsonSchema): ReadonlySet<string> {
  const required = Array.isArray(schema["required"]) ? schema["required"] : [];
  const properties = isRecord(schema["properties"]) ? schema["properties"] : {};
  return new Set(
    required.filter(
      (name): name is string =>
        typeof name === "string" && isRecord(properties[name]),
    ),
  );
}

/**
 * Required field to the `refs` key that fills it: the parent resource, then
 * each scope by its key.
 */
function refsOf(resource: Typed, model: GenModel): ReadonlyMap<string, string> {
  const fields = requiredFields(resource.schema);
  const refs = new Map<string, string>();
  if (resource.parent !== undefined && fields.has(resource.parent.field)) {
    refs.set(resource.parent.field, "parent");
  }
  for (const scope of model.scopes) {
    if (
      scope.key !== undefined &&
      fields.has(scope.key) &&
      IDENTIFIER.test(scope.name)
    ) {
      refs.set(scope.key, scope.name);
    }
  }
  return refs;
}

function factory(resource: Typed, model: GenModel): string {
  const row = `${pascalCase(resource.name)}Row`;
  const refs = refsOf(resource, model);
  const used = [...new Set(refs.values())].map(
    (name) => `readonly ${name}?: Ref`,
  );
  const fill = objectValue(resource.schema, 0, refs);
  const params = [
    `overrides: Partial<${row}> = {}`,
    ...(used.length === 0 ? [] : [`refs: { ${used.join("; ")} } = {}`]),
  ];
  return `  ${key(resource.ident)}: (${params.join(", ")}): ${row} => (${fill === "{}" ? "{ ...overrides }" : `{ ...${fill}, ...overrides }`}),`;
}

const RUNTIME = `let sequence = 0;

/** Restarts the ids and names, so a test reads the same rows on every run. */
export function resetFactories(): void {
  sequence = 0;
}

function next(): number {
  sequence += 1;
  return sequence;
}

function uuid(): string {
  return \`00000000-0000-4000-8000-\${String(next()).padStart(12, "0")}\`;
}

function text(field: string, min: number, max: number): string {
  return \`\${field}-\${String(next())}\`.padEnd(min, "x").slice(0, max);
}

type Ref = string | { readonly id: string };

function idOf(ref: Ref): string {
  return typeof ref === "string" ? ref : ref.id;
}`;

/**
 * `factories`: a row builder per resource that fills the required fields with
 * valid values, plus `subject` for a principal with typed roles and
 * memberships.
 */
export function factoriesModule(model: GenModel): string {
  const resources = model.resources.filter(
    (resource): resource is Typed => resource.schema !== undefined,
  );
  const types = resources.map(
    (resource) =>
      `export type ${pascalCase(resource.name)}Row = ${typeOf(resource.schema)};`,
  );
  const roles = model.roles.map((role) => JSON.stringify(role)).join(" | ");
  const scopes = model.scopes
    .map((scope) => JSON.stringify(scope.name))
    .join(" | ");
  const subject = `export type FactoryMembership = {
  readonly scope: ${scopes === "" ? "string" : scopes};
  readonly id: string;
  readonly roles: readonly (${roles === "" ? "string" : roles})[];
};

export type FactorySubject = Principal & {
  readonly roles: readonly (${roles === "" ? "string" : roles})[];
  readonly memberships: readonly FactoryMembership[];
};`;
  const body = [
    ...resources.map((resource) => factory(resource, model)),
    `  subject: (input: Partial<FactorySubject> = {}): FactorySubject => ({ id: uuid(), roles: [], memberships: [], ...input }),`,
  ];
  return `${[
    GENERATED,
    'import type { Principal } from "permdock";',
    RUNTIME,
    ...types,
    subject,
    `export const factories = {\n${body.join("\n")}\n};`,
  ].join("\n\n")}\n`;
}
