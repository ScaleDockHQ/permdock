import type { StandardSchemaV1 } from "@standard-schema/spec";

import type { CatalogMetaField } from "./references.ts";
import type { CatalogDocument } from "./types.ts";

import { freezeDeep } from "../core/freeze.ts";
import { checkSchema, copyJson } from "../core/json-schema.ts";
import { PermDockValidationError } from "../core/validation-error.ts";
import { catalogReferenceIssues } from "./references.ts";
import { catalogSchema } from "./schema.ts";

type Issues = StandardSchemaV1.Issue[];

function invalid(issues: readonly StandardSchemaV1.Issue[]): never {
  const [first] = issues;
  const where =
    first?.path === undefined || first.path.length === 0
      ? ""
      : ` at ${first.path.map(String).join(".")}`;
  const more =
    issues.length > 1 ? ` (and ${String(issues.length - 1)} more)` : "";
  throw new PermDockValidationError({
    code: "invalid-data",
    permission: "",
    resource: "",
    boundary: "catalog",
    issues,
    message: `PermDock: invalid catalog${where}: ${first?.message ?? "unknown"}${more}`,
  });
}

export type ParseCatalogOptions = {
  /** Permission `meta` fields every permission must carry; none by default. */
  readonly requireMeta?: readonly CatalogMetaField[];
};

/**
 * Reads a `permissions.catalog.json` document (parsed, or the JSON text),
 * validates it against `schemas/catalog-v1.json`, then checks its references:
 * role scopes, the permission keys operations, grants, delegations and OAuth
 * scopes name, unique keys, and `requireMeta`. Returns a deep-frozen copy built
 * from own keys; throws `PermDockValidationError` with every issue, each with
 * its `path`.
 */
export function parseCatalog(
  json: unknown,
  options: ParseCatalogOptions = {},
): CatalogDocument {
  const issues: Issues = [];
  let input = json;
  if (typeof json === "string") {
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
  const catalog = copy as CatalogDocument;
  const references = catalogReferenceIssues(catalog, options.requireMeta);
  if (references.length > 0) {
    invalid(references);
  }
  return freezeDeep(catalog);
}

/**
 * Keys of the permissions the catalog marks `rowConditions: true`: the SQL
 * helpers alone cannot enforce them.
 */
export function rowConditionKeys(
  catalog: CatalogDocument,
): ReadonlySet<string> {
  return new Set(
    catalog.permissions
      .filter((permission) => permission.rowConditions === true)
      .map((permission) => permission.key),
  );
}
