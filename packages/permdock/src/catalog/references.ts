import type { StandardSchemaV1 } from "@standard-schema/spec";

import type { CatalogDocument } from "./types.ts";

import { isRecord } from "../core/compact.ts";
import { resolveScope, scopeList } from "../core/scopes.ts";

type Issues = StandardSchemaV1.Issue[];

/** A permission `meta` field `parseCatalog` can require. */
export type CatalogMetaField = "title" | "risk" | "effects";

function duplicates(
  issues: Issues,
  list: readonly unknown[] | undefined,
  name: string,
  field: string,
): void {
  const seen = new Set<string>();
  for (const [index, entry] of (list ?? []).entries()) {
    const value = isRecord(entry) ? entry[field] : undefined;
    if (typeof value !== "string") {
      continue;
    }
    if (seen.has(value)) {
      issues.push({
        message: `duplicate ${field} '${value}' in ${name}`,
        path: [name, index, field],
      });
    }
    seen.add(value);
  }
}

/**
 * The cross-references JSON Schema cannot express: role scopes, permission keys
 * named by operations, grants, delegations and OAuth scopes, unique keys, and
 * with `requireMeta` the permission `meta` fields a consumer needs. Runs on a
 * document that already passed the schema.
 */
export function catalogReferenceIssues(
  catalog: CatalogDocument,
  requireMeta: readonly CatalogMetaField[] = [],
): Issues {
  const issues: Issues = [];
  duplicates(issues, catalog.permissions, "permissions", "key");
  duplicates(issues, catalog.roles, "roles", "key");
  duplicates(issues, catalog.scopes, "scopes", "name");
  duplicates(issues, catalog.plans, "plans", "key");
  duplicates(issues, catalog.operations, "operations", "name");

  const keys = new Set(catalog.permissions.map((permission) => permission.key));
  const declared = (
    key: string,
    path: readonly (string | number)[],
    what: string,
  ): void => {
    if (!keys.has(key)) {
      issues.push({
        message: `${what} '${key}' is not a declared permission key`,
        path,
      });
    }
  };

  const scopes = scopeList(catalog.scopes);
  for (const [index, role] of (catalog.roles ?? []).entries()) {
    if (
      role.on !== undefined &&
      role.on !== "resource" &&
      resolveScope(scopes, role.on) === undefined
    ) {
      issues.push({
        message: `role '${role.key}' is on '${role.on}', which is neither a declared scope nor resource`,
        path: ["roles", index, "on"],
      });
    }
  }
  for (const [index, operation] of (catalog.operations ?? []).entries()) {
    declared(
      operation.permission,
      ["operations", index, "permission"],
      `operation '${operation.name}' permission`,
    );
    if (operation.results !== undefined) {
      declared(
        operation.results,
        ["operations", index, "results"],
        `operation '${operation.name}' results`,
      );
    }
  }
  for (const [index, grant] of (catalog.grants ?? []).entries()) {
    declared(grant.permission, ["grants", index, "permission"], "grant");
  }
  for (const [index, delegation] of (catalog.delegations ?? []).entries()) {
    for (const [at, key] of delegation.permissions.entries()) {
      declared(key, ["delegations", index, "permissions", at], "delegation");
    }
  }
  for (const [index, scope] of (catalog.oauthScopes ?? []).entries()) {
    for (const [at, key] of scope.permissions.entries()) {
      declared(
        key,
        ["oauthScopes", index, "permissions", at],
        `OAuth scope '${scope.scope}'`,
      );
    }
  }
  for (const [index, permission] of catalog.permissions.entries()) {
    for (const field of requireMeta) {
      if (permission.meta[field] === undefined) {
        issues.push({
          message: `permission '${permission.key}' needs meta.${field}`,
          path: ["permissions", index, "meta", field],
        });
      }
    }
  }
  return issues;
}
