import type { GeneratedResource } from "../generate.ts";

import { byCodePoint } from "../../core/compare.ts";
import { emitPermissionsModule } from "../generate.ts";

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;

/**
 * Actions a collection permission decides: there is no row yet, or a list of
 * rows.
 */
const COLLECTION_ACTIONS: ReadonlySet<string> = new Set(["create", "list"]);

/** A condition value: JSON, or a field of the principal (`principal.id`). */
export type ImportedValue =
  | string
  | number
  | boolean
  | null
  | { readonly principal: string }
  | readonly ImportedValue[];

/**
 * The `where` shorthand an imported grant carries, as data until it is
 * rendered.
 */
export type ImportedWhere =
  | { readonly and: readonly ImportedWhere[] }
  | { readonly or: readonly ImportedWhere[] }
  | { readonly not: ImportedWhere }
  | {
      readonly field: string;
      readonly op:
        | "eq"
        | "ne"
        | "gt"
        | "gte"
        | "lt"
        | "lte"
        | "in"
        | "notIn"
        | "isNull";
      readonly value: ImportedValue;
    };

export type ImportedGrant = {
  readonly effect: "allow" | "deny";
  readonly resource: string;
  readonly action: string;
  readonly where?: ImportedWhere;
  readonly fields?: readonly string[];
};

export type ImportedRole = {
  readonly name: string;
  readonly grants: readonly ImportedGrant[];
};

/** Whether `name` can be a resource or action key in generated code. */
export function isIdentifier(name: string): boolean {
  return IDENTIFIER.test(name);
}

function quote(value: string): string {
  return `'${value.replaceAll("\\", "\\\\").replaceAll("'", "\\'")}'`;
}

function isValueList(value: ImportedValue): value is readonly ImportedValue[] {
  return Array.isArray(value);
}

function renderValue(value: ImportedValue): string {
  if (value === null) {
    return "null";
  }
  if (isValueList(value)) {
    return `[${value.map((item) => renderValue(item)).join(", ")}]`;
  }
  if (typeof value === "object") {
    // The CASL reader accepts only `${user.<identifier>}` templates.
    return `principal.${value.principal}`;
  }
  return typeof value === "string" ? quote(value) : String(value);
}

function propertyKey(name: string): string {
  return isIdentifier(name) ? name : quote(name);
}

function renderWhere(where: ImportedWhere): string {
  if ("and" in where) {
    return `{ and: [${where.and.map(renderWhere).join(", ")}] }`;
  }
  if ("or" in where) {
    return `{ or: [${where.or.map(renderWhere).join(", ")}] }`;
  }
  if ("not" in where) {
    return `{ not: ${renderWhere(where.not)} }`;
  }
  const value = renderValue(where.value);
  return where.op === "eq"
    ? `{ ${propertyKey(where.field)}: ${value} }`
    : `{ ${propertyKey(where.field)}: { ${where.op}: ${value} } }`;
}

function renderGrant(grant: ImportedGrant): string {
  const options = [
    ...(grant.where === undefined
      ? []
      : [`where: ${renderWhere(grant.where)}`]),
    ...(grant.fields === undefined
      ? []
      : [`fields: [${grant.fields.map(quote).join(", ")}]`]),
  ];
  const permission = `permissions.${grant.resource}.${grant.action}`;
  return options.length === 0
    ? `${grant.effect}(${permission})`
    : `${grant.effect}(${permission}, { ${options.join(", ")} })`;
}

function usesPrincipal(where: ImportedWhere | undefined): boolean {
  return where !== undefined && JSON.stringify(where).includes('"principal"');
}

/**
 * Resources keyed by name, each with its actions split into instance and
 * collection ones.
 */
function resourcesOf(
  actions: ReadonlyMap<string, ReadonlySet<string>>,
): readonly GeneratedResource[] {
  return [...actions.entries()]
    .toSorted(([a], [b]) => byCodePoint(a, b))
    .map(([name, set]) => {
      const sorted = [...set].toSorted();
      return {
        path: [name],
        actions: sorted.filter((action) => !COLLECTION_ACTIONS.has(action)),
        collection: sorted.filter((action) => COLLECTION_ACTIONS.has(action)),
      };
    });
}

/**
 * A deterministic module with the imported `permissions` and a `policy` of
 * their roles. Rules stay data: an import writes declarations and grants, never
 * code an application maintains by hand.
 */
export function emitPolicyModule(input: {
  readonly generator: string;
  readonly actions: ReadonlyMap<string, ReadonlySet<string>>;
  readonly roles: readonly ImportedRole[];
  readonly exports?: Readonly<Record<string, unknown>>;
}): string {
  const permissionsModule = emitPermissionsModule({
    generator: input.generator,
    schema: undefined,
    resources: resourcesOf(input.actions),
    ...(input.exports === undefined ? {} : { exports: input.exports }),
  });
  const grants = input.roles.flatMap((role) => role.grants);
  const names = new Set([
    "definePermissions",
    "definePolicy",
    "resource",
    "role",
  ]);
  for (const grant of grants) {
    names.add(grant.effect);
  }
  if (grants.some((grant) => usesPrincipal(grant.where))) {
    names.add("principal");
  }
  const imports = `import { ${[...names].toSorted().join(", ")} } from 'permdock'`;
  const roles = input.roles
    .toSorted((a, b) => byCodePoint(a.name, b.name))
    .map((role) => {
      const body = role.grants.map((grant) => `      ${renderGrant(grant)},`);
      return body.length === 0
        ? `    role(${quote(role.name)}, []),`
        : `    role(${quote(role.name)}, [\n${body.join("\n")}\n    ]),`;
    });
  return `${permissionsModule.replace(
    "import { definePermissions, resource } from 'permdock'",
    imports,
  )}
export const policy = definePolicy(permissions, {
  roles: [
${roles.join("\n")}
  ],
  subject: (user: { readonly id: string; readonly roles: readonly string[] }) =>
    user,
})
`;
}
