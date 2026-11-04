import type { Permission, PermissionTree } from "../core/permission-types.ts";

import { isRecord } from "../core/compact.ts";
import { findPermission, isPermission } from "../core/permission-registry.ts";

export const HTTP_METHODS: ReadonlySet<string> = new Set([
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

/**
 * One declared operation: a permission, or a permission with the operation id a
 * tool name uses and the OAuth scopes that reach it, or only OAuth scopes for a
 * route that checks no permission (`protect(null)`).
 */
export type OperationEntry =
  | Permission
  | {
      readonly permission: Permission;
      readonly operationId?: string;
      readonly oauthScopes?: readonly string[];
    }
  | {
      readonly permission?: undefined;
      readonly operationId?: string;
      readonly oauthScopes: readonly string[];
    };

/**
 * The permission of each operation of an API, declared once and read by the
 * HTTP gate and by `permdock/mcp`'s `permissionFor`, so a REST route and the
 * MCP tool that calls it can never disagree.
 */
export type OperationPermissions = {
  /**
   * The permission of a request: the declared operation whose method and path
   * template match, a literal segment winning over a `{param}`. `undefined` for
   * an undeclared operation, which a gate denies, and for an operation that
   * declares only OAuth scopes. A `HEAD` request matches the `GET` entry of its
   * path when no `HEAD` entry matches.
   */
  forRequest: (method: string, path: string) => Permission | undefined;
  /**
   * The permission of an operation id; pass it as `permissionFor` when tool
   * names are operation ids.
   */
  forOperation: (id: string) => Permission | undefined;
  oauthScopesForRequest: (
    method: string,
    path: string,
  ) => readonly string[] | undefined;
  oauthScopesForOperation: (id: string) => readonly string[] | undefined;
  /**
   * Every declared operation in declaration order, with the key's method
   * upper-cased and its path template as written. `testOperationCoverage` and
   * `permdock doctor` (PD091) compare it with an OpenAPI document.
   */
  entries: () => readonly OperationDeclaration[];
};

/** One declared operation as `OperationPermissions.entries()` lists it. */
export type OperationDeclaration = {
  readonly method: string;
  readonly path: string;
  readonly permission?: Permission;
  readonly operationId?: string;
  readonly oauthScopes?: readonly string[];
};

/** An OpenAPI operation `operationPermissionsFromOpenApi` read. */
export type OpenApiOperationRef = {
  readonly method: string;
  readonly path: string;
  readonly operationId?: string;
};

/** Why `operationPermissionsFromOpenApi` left an operation out. */
export type OperationSkipCause =
  | "no-permission"
  | "several-permissions"
  | "unknown-permission"
  | "invalid-extension";

/** Every skip cause, for a table or an exhaustive switch. */
export const OPERATION_SKIP_CAUSES: readonly OperationSkipCause[] = [
  "no-permission",
  "several-permissions",
  "unknown-permission",
  "invalid-extension",
];

type Route = {
  readonly method: string;
  readonly path: string;
  readonly operationId?: string;
  readonly segments: readonly string[];
  readonly permission: Permission | undefined;
  readonly oauthScopes?: readonly string[];
};

function segmentsOf(path: string): readonly string[] {
  return path.split("/").filter((segment) => segment !== "");
}

function isParam(segment: string): boolean {
  return segment.startsWith("{") && segment.endsWith("}");
}

/**
 * The number of literal segments that match, or -1 when the template does not
 * match.
 */
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

type EntryObject = Exclude<OperationEntry, Permission>;

function isEntryObject(entry: OperationEntry): entry is EntryObject {
  return !isPermission(entry);
}

function scopesOf(
  key: string,
  entry: OperationEntry,
): readonly string[] | undefined {
  if (!isEntryObject(entry) || entry.oauthScopes === undefined) {
    return undefined;
  }
  const scopes: readonly unknown[] = entry.oauthScopes;
  if (
    scopes.length === 0 ||
    !scopes.every((scope) => typeof scope === "string" && scope !== "")
  ) {
    throw new TypeError(
      `PermDock: operation '${key}' sets oauthScopes, which must be a non-empty list of scope names`,
    );
  }
  return Object.freeze([...entry.oauthScopes]);
}

/**
 * Operations as `"METHOD /path/{param}"` keys, the OpenAPI path template, to a
 * permission. `base` is a prefix requests carry and the keys do not
 * (`/api/v1`). A key that is not a method and a path throws.
 */
export function operationPermissions(
  operations: Readonly<Record<string, OperationEntry>>,
  options: { readonly base?: string } = {},
): OperationPermissions {
  const routes: Route[] = [];
  const byId = new Map<string, Route>();
  for (const [key, entry] of Object.entries(operations)) {
    const space = key.indexOf(" ");
    const method = key.slice(0, space).toUpperCase();
    const path = key.slice(space + 1).trim();
    if (space <= 0 || !HTTP_METHODS.has(method) || !path.startsWith("/")) {
      throw new TypeError(
        `PermDock: operation '${key}' must be a method and a path, such as 'GET /customers/{id}'`,
      );
    }
    const oauthScopes = scopesOf(key, entry);
    if (
      isEntryObject(entry) &&
      (entry.permission === undefined
        ? oauthScopes === undefined
        : !isPermission(entry.permission))
    ) {
      throw new TypeError(
        `PermDock: operation '${key}' needs a permission, oauthScopes or both`,
      );
    }
    const route: Route = {
      method,
      path,
      ...(isEntryObject(entry) && entry.operationId !== undefined
        ? { operationId: entry.operationId }
        : {}),
      segments: segmentsOf(path),
      permission: isEntryObject(entry) ? entry.permission : entry,
      ...(oauthScopes === undefined ? {} : { oauthScopes }),
    };
    routes.push(route);
    if (isEntryObject(entry) && entry.operationId !== undefined) {
      byId.set(entry.operationId, route);
    }
  }
  const base = segmentsOf(options.base ?? "");
  const matchMethod = (upper: string, path: string): Route | undefined => {
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
    return best;
  };
  const match = (method: string, path: string): Route | undefined => {
    const upper = method.toUpperCase();
    const route = matchMethod(upper, path);
    return route === undefined && upper === "HEAD"
      ? matchMethod("GET", path)
      : route;
  };
  return {
    forRequest(method, path) {
      return match(method, path)?.permission;
    },
    forOperation(id) {
      return byId.get(id)?.permission;
    },
    oauthScopesForRequest(method, path) {
      return match(method, path)?.oauthScopes;
    },
    oauthScopesForOperation(id) {
      return byId.get(id)?.oauthScopes;
    },
    entries() {
      return routes.map((route) => ({
        method: route.method,
        path: route.path,
        ...(route.permission === undefined
          ? {}
          : { permission: route.permission }),
        ...(route.operationId === undefined
          ? {}
          : { operationId: route.operationId }),
        ...(route.oauthScopes === undefined
          ? {}
          : { oauthScopes: route.oauthScopes }),
      }));
    },
  };
}

/**
 * The operation permissions an OpenAPI document declares: every operation whose
 * `x-permdock-permissions` names exactly one permission of `tree`, keyed by its
 * method, path and `operationId`. An operation naming none, several or an
 * unknown key is left out, so a gate denies it; `onSkip` hears each one with
 * its cause.
 */
export function operationPermissionsFromOpenApi(
  document: unknown,
  tree: PermissionTree,
  options: {
    readonly base?: string;
    readonly onSkip?: (
      operation: OpenApiOperationRef,
      cause: OperationSkipCause,
    ) => void;
  } = {},
): OperationPermissions {
  const operations: Record<string, OperationEntry> = {};
  const paths =
    isRecord(document) && isRecord(document["paths"]) ? document["paths"] : {};
  for (const [path, item] of Object.entries(paths)) {
    if (!isRecord(item)) {
      continue;
    }
    for (const [method, operation] of Object.entries(item)) {
      if (!HTTP_METHODS.has(method.toUpperCase()) || !isRecord(operation)) {
        continue;
      }
      const operationId = operation["operationId"];
      const ref: OpenApiOperationRef = {
        method: method.toUpperCase(),
        path,
        ...(typeof operationId === "string" ? { operationId } : {}),
      };
      const keys = operation["x-permdock-permissions"];
      if (keys === undefined) {
        options.onSkip?.(ref, "no-permission");
        continue;
      }
      if (
        !Array.isArray(keys) ||
        !keys.every((key) => typeof key === "string")
      ) {
        options.onSkip?.(ref, "invalid-extension");
        continue;
      }
      const [key] = keys;
      if (key === undefined || keys.length !== 1) {
        options.onSkip?.(
          ref,
          key === undefined ? "no-permission" : "several-permissions",
        );
        continue;
      }
      const permission = findPermission(tree, key);
      if (permission === undefined) {
        options.onSkip?.(ref, "unknown-permission");
        continue;
      }
      operations[`${ref.method} ${path}`] =
        typeof operationId === "string"
          ? { permission, operationId }
          : permission;
    }
  }
  return operationPermissions(
    operations,
    options.base === undefined ? {} : { base: options.base },
  );
}
