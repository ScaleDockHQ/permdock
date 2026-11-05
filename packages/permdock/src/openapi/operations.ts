import type { Permission, PermissionTree } from "../core/permission-types.ts";

import { isRecord } from "../core/compact.ts";
import { findPermission, isPermission } from "../core/permission-registry.ts";
import { oauthSchemes, oauthScopesOf } from "./oauth-security.ts";

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
 * Who enforces an operation. `kernel` is the default: the server kernel checks
 * the permission before the handler runs. `handler` marks an operation whose
 * handler checks the permission itself, so a kernel gate must not require an
 * entry for it.
 */
export type OperationEnforcement = "kernel" | "handler";

/**
 * One declared operation: a permission, or a permission with the operation id a
 * tool name uses, the OAuth scopes that reach it and who enforces it, or only
 * OAuth scopes for a route that checks no permission (`protect(null)`).
 */
export type OperationEntry =
  | Permission
  | {
      readonly permission: Permission;
      readonly operationId?: string;
      readonly oauthScopes?: readonly string[];
      readonly enforcement?: OperationEnforcement;
    }
  | {
      readonly permission?: undefined;
      readonly operationId?: string;
      readonly oauthScopes: readonly string[];
      readonly enforcement?: OperationEnforcement;
    };

/**
 * The permission of each operation of an API, declared once and read by the
 * HTTP gate and by `permdock/mcp`'s `permissionFor`, so a REST route and the
 * MCP tool that calls it can never disagree.
 */
export type OperationPermissions = OperationLookup & {
  /** The operations the kernel enforces; an entry with no `enforcement` is one. */
  readonly kernel: OperationLookup;
  /** The operations whose handler enforces them. */
  readonly handler: OperationLookup;
};

/** The lookups of a set of operations. */
export type OperationLookup = {
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
  readonly enforcement: OperationEnforcement;
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
  | "invalid-extension"
  | "public";

/** Every skip cause, for a table or an exhaustive switch. */
export const OPERATION_SKIP_CAUSES: readonly OperationSkipCause[] = [
  "no-permission",
  "several-permissions",
  "unknown-permission",
  "invalid-extension",
  "public",
];

type Route = {
  readonly method: string;
  readonly path: string;
  readonly operationId?: string;
  readonly segments: readonly string[];
  readonly permission: Permission | undefined;
  readonly oauthScopes?: readonly string[];
  readonly enforcement: OperationEnforcement;
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

function enforcementOf(
  key: string,
  entry: OperationEntry,
): OperationEnforcement {
  if (!isEntryObject(entry) || entry.enforcement === undefined) {
    return "kernel";
  }
  const value: unknown = entry.enforcement;
  if (value !== "kernel" && value !== "handler") {
    throw new TypeError(
      `PermDock: operation '${key}' sets enforcement to '${String(value)}', which must be 'kernel' or 'handler'`,
    );
  }
  return value;
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
      enforcement: enforcementOf(key, entry),
    };
    routes.push(route);
    if (isEntryObject(entry) && entry.operationId !== undefined) {
      byId.set(entry.operationId, route);
    }
  }
  const base = segmentsOf(options.base ?? "");
  const lookupOf = (
    subset: readonly Route[],
    ids: ReadonlyMap<string, Route>,
  ): OperationLookup => {
    const matchMethod = (upper: string, path: string): Route | undefined => {
      const full = segmentsOf(path.split("?")[0] ?? "");
      if (base.some((segment, index) => full[index] !== segment)) {
        return undefined;
      }
      const segments = full.slice(base.length);
      let best: Route | undefined;
      let bestScore = -1;
      for (const route of subset) {
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
        return ids.get(id)?.permission;
      },
      oauthScopesForRequest(method, path) {
        return match(method, path)?.oauthScopes;
      },
      oauthScopesForOperation(id) {
        return ids.get(id)?.oauthScopes;
      },
      entries() {
        return subset.map((route) => ({
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
          enforcement: route.enforcement,
        }));
      },
    };
  };
  const idsOf = (subset: readonly Route[]): ReadonlyMap<string, Route> =>
    new Map(
      subset.flatMap((route): [string, Route][] =>
        route.operationId === undefined ? [] : [[route.operationId, route]],
      ),
    );
  const only = (enforcement: OperationEnforcement): readonly Route[] =>
    routes.filter((route) => route.enforcement === enforcement);
  const kernel = only("kernel");
  const handler = only("handler");
  return {
    ...lookupOf(routes, byId),
    kernel: lookupOf(kernel, idsOf(kernel)),
    handler: lookupOf(handler, idsOf(handler)),
  };
}

/**
 * The operation permissions an OpenAPI document declares: every operation whose
 * `x-permdock-permissions` names exactly one permission of `tree`, keyed by its
 * method, path and `operationId`, and every operation that has OAuth scopes in
 * its `security` requirement and names no permission (a scope-only entry). The
 * scopes come from `operation.security`, else `document.security`, for
 * `oauth2` and `openIdConnect` schemes. `x-permdock-enforcement` is `kernel`
 * (the default) or `handler`. An operation naming several or an unknown key,
 * an invalid extension, or `security: []` is left out, so a gate denies it;
 * `onSkip` hears each one with its cause.
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
  const schemes = oauthSchemes(document);
  const documentSecurity = isRecord(document) ? document["security"] : undefined;
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
      const enforcement = operation["x-permdock-enforcement"];
      if (
        enforcement !== undefined &&
        enforcement !== "kernel" &&
        enforcement !== "handler"
      ) {
        options.onSkip?.(ref, "invalid-extension");
        continue;
      }
      const mode: OperationEnforcement | undefined =
        enforcement === "kernel" || enforcement === "handler"
          ? enforcement
          : undefined;
      const security = Object.hasOwn(operation, "security")
        ? operation["security"]
        : documentSecurity;
      const scopes = oauthScopesOf(security, schemes);
      const keys = operation["x-permdock-permissions"];
      let permission: Permission | undefined;
      if (keys === undefined) {
        if (scopes.length === 0) {
          const open = Array.isArray(security) && security.length === 0;
          options.onSkip?.(ref, open ? "public" : "no-permission");
          continue;
        }
      } else {
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
        permission = findPermission(tree, key);
        if (permission === undefined) {
          options.onSkip?.(ref, "unknown-permission");
          continue;
        }
      }
      const extras = {
        ...(typeof operationId === "string" ? { operationId } : {}),
        ...(scopes.length === 0 ? {} : { oauthScopes: scopes }),
        ...(mode === undefined ? {} : { enforcement: mode }),
      };
      const label = `${ref.method} ${path}`;
      if (permission === undefined) {
        operations[label] = { ...extras, oauthScopes: scopes };
      } else {
        operations[label] =
          Object.keys(extras).length === 0
            ? permission
            : { ...extras, permission };
      }
    }
  }
  return operationPermissions(
    operations,
    options.base === undefined ? {} : { base: options.base },
  );
}
