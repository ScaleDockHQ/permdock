import type { CatalogOperation } from "../../catalog/types.ts";
import type { Policy } from "../../core/policy-types.ts";
import type { Scope } from "../../core/scopes.ts";
import type { ResourceNode } from "../../index.ts";
import type { JsonSchema } from "../generate.ts";
import type { ResolvedNames } from "../sql/resolve-names.ts";
import type { PermDockConfig, RlsStorageBucket } from "../types.ts";

import { isRecord } from "../../core/compact.ts";
import { byCodePoint } from "../../core/compare.ts";
import { listPermissions } from "../../core/permission-registry.ts";
import { scopeList } from "../../core/scopes.ts";
import { listRoles } from "../../core/vocabulary.ts";
import { jsonSchemaOf } from "../catalog-doc.ts";
import { configError } from "../core/errors.ts";
import { resolveNames } from "../sql/resolve-names.ts";

export type GenResource = {
  /** The resource path, as `leaf.resource` carries it. */
  readonly name: string;
  /** `camelCase` of the path: `org.post` is `orgPost`. */
  readonly ident: string;
  /** The resource schema as JSON Schema; `undefined` without one. */
  readonly schema: JsonSchema | undefined;
  readonly parent?: { readonly field: string; readonly resource: string };
  readonly title?: string;
};

export type GenOperation = {
  readonly name: string;
  readonly ident: string;
  /** The resource whose rows `results` filters. */
  readonly results?: string;
};

/** What every `permdock gen` kind reads. */
export type GenModel = {
  readonly resources: readonly GenResource[];
  readonly operations: readonly GenOperation[];
  readonly scopes: readonly Scope[];
  readonly roles: readonly string[];
  readonly names: ResolvedNames;
  /** `rls.realtime.topics` keys, such as `org:{organization}:quotes`. */
  readonly topics: readonly string[];
  readonly buckets: readonly (readonly [string, RlsStorageBucket])[];
};

/** `org.post` to `orgPost`, `quote-files` to `quoteFiles`. */
export function camelCase(name: string): string {
  const words = name.split(/[^A-Za-z0-9]+/u).filter((word) => word !== "");
  const joined = words
    .map((word, index) =>
      index === 0
        ? `${word.charAt(0).toLowerCase()}${word.slice(1)}`
        : `${word.charAt(0).toUpperCase()}${word.slice(1)}`,
    )
    .join("");
  return /^[0-9]/u.test(joined) ? `_${joined}` : joined;
}

export function pascalCase(name: string): string {
  const camel = camelCase(name);
  return `${camel.charAt(0).toUpperCase()}${camel.slice(1)}`;
}

function unique<T extends { readonly name: string; readonly ident: string }>(
  kind: string,
  items: readonly T[],
): readonly T[] {
  const seen = new Map<string, string>();
  for (const item of items) {
    const other = seen.get(item.ident);
    if (other !== undefined) {
      throw configError(
        `PermDock CLI: ${kind} '${other}' and '${item.name}' both generate the name '${item.ident}'; rename one of them`,
      );
    }
    if (item.ident === "") {
      throw configError(
        `PermDock CLI: ${kind} '${item.name}' has no letters or digits to name it by`,
      );
    }
    seen.set(item.ident, item.name);
  }
  return items;
}

function isNullType(value: unknown): boolean {
  return isRecord(value) && value["type"] === "null";
}

/**
 * `anyOf: [T, { type: 'null' }]`, which Zod and Valibot write for a nullable
 * field, folded into `T` with `null` in `type` (and `enum`), so every kind
 * reads one shape.
 */
function foldNullable(schema: JsonSchema): JsonSchema {
  const options = schema["anyOf"];
  let node = schema;
  if (Array.isArray(options) && options.length === 2) {
    const other = options.find((option) => !isNullType(option));
    if (options.some(isNullType) && isRecord(other)) {
      const { anyOf: _, ...rest } = schema;
      const type = other["type"];
      const values = other["enum"];
      node = {
        ...rest,
        ...other,
        ...(typeof type === "string" ? { type: [type, "null"] } : {}),
        ...(Array.isArray(values) ? { enum: [...values, null] } : {}),
      };
    }
  }
  const properties = node["properties"];
  const items = node["items"];
  return {
    ...node,
    ...(isRecord(properties)
      ? {
          properties: Object.fromEntries(
            Object.entries(properties).map(([name, child]) => [
              name,
              isRecord(child) ? foldNullable(child) : child,
            ]),
          ),
        }
      : {}),
    ...(isRecord(items) ? { items: foldNullable(items) } : {}),
  };
}

function schemaOf(value: unknown): JsonSchema | undefined {
  return isRecord(value) ? foldNullable(value) : undefined;
}

function genResource(node: ResourceNode): GenResource {
  const title = node.meta?.title;
  return {
    name: node.name,
    ident: camelCase(node.name),
    schema: schemaOf(jsonSchemaOf(node)),
    ...(node.parent === undefined
      ? {}
      : {
          parent: { field: node.parent.field, resource: node.parent.resource },
        }),
    ...(title === undefined ? {} : { title }),
  };
}

function genOperation(
  operation: CatalogOperation,
  resourceOf: ReadonlyMap<string, string>,
): GenOperation {
  const results =
    operation.results === undefined
      ? undefined
      : resourceOf.get(operation.results);
  return {
    name: operation.name,
    ident: camelCase(operation.name),
    ...(results === undefined ? {} : { results }),
  };
}

export function genModel(input: {
  readonly policy: Policy;
  readonly config: PermDockConfig;
  readonly operations?: readonly CatalogOperation[] | undefined;
}): GenModel {
  const { policy, config } = input;
  const leaves = listPermissions(policy.vocabulary.permissions);
  const resourceOf = new Map(leaves.map((leaf) => [leaf.key, leaf.resource]));
  const resources = [...policy.resources.values()]
    .map(genResource)
    .toSorted((a, b) => byCodePoint(a.name, b.name));
  const operations = (input.operations ?? [])
    .map((operation) => genOperation(operation, resourceOf))
    .toSorted((a, b) => byCodePoint(a.name, b.name));
  return {
    resources: unique("resource", resources),
    operations: unique("operation", operations),
    scopes: scopeList(policy.scopes),
    roles: [
      ...new Set([
        ...policy.roles.map((binding) => binding.name),
        ...listRoles(policy.vocabulary.roles).map((role) => role.key),
      ]),
    ].toSorted(byCodePoint),
    names: resolveNames(policy, config),
    topics: Object.keys(config.rls?.realtime?.topics ?? {}).toSorted(
      byCodePoint,
    ),
    buckets: Object.entries(config.rls?.storage?.buckets ?? {}).toSorted(
      ([a], [b]) => byCodePoint(a, b),
    ),
  };
}
