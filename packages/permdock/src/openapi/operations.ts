import type { Permission, PermissionTree } from "../core/permissions.ts";

import { findPermission } from "../core/permissions.ts";

const METHODS = new Set([
  "GET",
  "PUT",
  "POST",
  "DELETE",
  "OPTIONS",
  "HEAD",
  "PATCH",
  "TRACE",
  "QUERY",
]);

/** One declared operation: a permission, or a permission with the operation id a tool name uses. */
export type OperationEntry =
  | Permission
  | { readonly permission: Permission; readonly operationId?: string };

/**
 * The permission of each operation of an API, declared once and read by the
 * HTTP gate and by `permdock/mcp`'s `permissionFor`, so a REST route and the
 * MCP tool that calls it can never disagree.
 */
export type OperationPermissions = {
  /**
   * The permission of a request: the declared operation whose method and
   * path template match, a literal segment winning over a `{param}`.
   * `undefined` for an undeclared operation, which a gate denies.
   */
  forRequest(method: string, path: string): Permission | undefined;
  /** The permission of an operation id; pass it as `permissionFor` when tool names are operation ids. */
  forOperation(id: string): Permission | undefined;
};

type Route = {
  readonly method: string;
  readonly segments: readonly string[];
  readonly permission: Permission;
};

function segmentsOf(path: string): readonly string[] {
  return path.split("/").filter((segment) => segment !== "");
}

function isParam(segment: string): boolean {
  return segment.startsWith("{") && segment.endsWith("}");
}

/** The number of literal segments that match, or -1 when the template does not match. */
function score(route: Route, segments: readonly string[]): number {
  if (route.segments.length !== segments.length) {
    return -1;
  }
  let literal = 0;
  for (const [index, segment] of route.segments.entries()) {
    if (isParam(segment)) {
      continue;
    }
    if (segment !== segments[index]) {
      return -1;
    }
    literal += 1;
  }
  return literal;
}

function isEntryObject(
  entry: OperationEntry,
): entry is { readonly permission: Permission; readonly operationId?: string } {
  return "permission" in entry && typeof entry.permission === "object";
}

/**
 * Operations as `"METHOD /path/{param}"` keys, the OpenAPI path template, to
 * a permission. `base` is a prefix requests carry and the keys do not
 * (`/api/v1`). A key that is not a method and a path throws.
 */
export function operationPermissions(
  operations: Readonly<Record<string, OperationEntry>>,
  options: { readonly base?: string } = {},
): OperationPermissions {
  const routes: Route[] = [];
  const byId = new Map<string, Permission>();
  for (const [key, entry] of Object.entries(operations)) {
    const space = key.indexOf(" ");
    const method = key.slice(0, space).toUpperCase();
    const path = key.slice(space + 1).trim();
    if (space <= 0 || !METHODS.has(method) || !path.startsWith("/")) {
      throw new TypeError(
        `PermDock: operation '${key}' must be a method and a path, such as 'GET /customers/{id}'`,
      );
    }
    const permission = isEntryObject(entry) ? entry.permission : entry;
    routes.push({ method, segments: segmentsOf(path), permission });
    if (isEntryObject(entry) && entry.operationId !== undefined) {
      byId.set(entry.operationId, permission);
    }
  }
  const base = segmentsOf(options.base ?? "");
  return {
    forRequest(method, path) {
      const upper = method.toUpperCase();
      const full = segmentsOf(path.split("?")[0] ?? "");
      if (base.some((segment, index) => full[index] !== segment)) {
        return undefined;
      }
      const segments = full.slice(base.length);
      let best: Route | undefined;
      let bestScore = -1;
      for (const route of routes) {
        if (route.method !== upper) {
          continue;
        }
        const value = score(route, segments);
        if (value > bestScore) {
          best = route;
          bestScore = value;
        }
      }
      return best?.permission;
    },
    forOperation(id) {
      return byId.get(id);
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The operation permissions an OpenAPI document declares: every operation
 * whose `x-permdock-permissions` names exactly one permission of `tree`, keyed
 * by its method, path and `operationId`. An operation naming none, several or
 * an unknown key is left out, so a gate denies it.
 */
export function operationPermissionsFromOpenApi(
  document: unknown,
  tree: PermissionTree,
  options: { readonly base?: string } = {},
): OperationPermissions {
  const operations: Record<string, OperationEntry> = {};
  const paths =
    isRecord(document) && isRecord(document["paths"]) ? document["paths"] : {};
  for (const [path, item] of Object.entries(paths)) {
    if (!isRecord(item)) {
      continue;
    }
    for (const [method, operation] of Object.entries(item)) {
      if (!METHODS.has(method.toUpperCase()) || !isRecord(operation)) {
        continue;
      }
      const keys = operation["x-permdock-permissions"];
      if (
        !Array.isArray(keys) ||
        keys.length !== 1 ||
        typeof keys[0] !== "string"
      ) {
        continue;
      }
      const permission = findPermission(tree, keys[0]);
      if (permission === undefined) {
        continue;
      }
      const operationId = operation["operationId"];
      operations[`${method.toUpperCase()} ${path}`] =
        typeof operationId === "string"
          ? { permission, operationId }
          : permission;
    }
  }
  return operationPermissions(operations, options);
}
