export type AnnotatedRoute = {
  readonly method: string;
  readonly path: string;
  readonly permission?: string;
  readonly check?: "kernel" | "handler";
  readonly oauthScopes?: readonly string[];
};

const ROUTE =
  /\/\*\*([\s\S]*?)\*\/\s*export\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS|QUERY)\b/gu;

const TAG = /@(\w+)\s+([^\n*]+)/gu;

/**
 * The HTTP path of an App Router `route` file: `app/orgs/[org]/posts/route.ts`
 * is `/orgs/{org}/posts`.
 */
export function routePath(file: string): string | undefined {
  const normalized = file.replaceAll("\\", "/");
  const match = /(?:^|\/)app\/(.+)\/route\.[cm]?[jt]sx?$/u.exec(normalized);
  const segments = match?.[1];
  if (segments === undefined) {
    return undefined;
  }
  const path = segments
    .split("/")
    .filter((segment) => segment !== "" && !segment.startsWith("("))
    .map((segment) =>
      segment.startsWith("[") && segment.endsWith("]")
        ? `{${segment.slice(1, -1).replace(/^\.\.\./u, "")}}`
        : segment,
    )
    .join("/");
  return `/${path}`;
}

function tagsOf(block: string): {
  readonly permission?: string;
  readonly check?: "kernel" | "handler";
  readonly oauthScopes?: readonly string[];
} {
  let permission: string | undefined;
  let check: "kernel" | "handler" | undefined;
  let oauthScopes: readonly string[] | undefined;
  for (const match of block.matchAll(TAG)) {
    const name = match[1];
    const value = (match[2] ?? "").trim();
    if (name === "permission" && value !== "") {
      permission = value.split(/\s+/u)[0];
    } else if (
      name === "permissionCheck" &&
      (value === "kernel" || value === "handler")
    ) {
      check = value;
    } else if (name === "oauthScopes" && value !== "") {
      oauthScopes = value.split(/\s+/u);
    }
  }
  return {
    ...(permission === undefined ? {} : { permission }),
    ...(check === undefined ? {} : { check }),
    ...(oauthScopes === undefined ? {} : { oauthScopes }),
  };
}

/** Operations declared on route handlers in `source`. */
export function routesFromSource(
  file: string,
  source: string,
): readonly AnnotatedRoute[] {
  const path = routePath(file);
  if (path === undefined) {
    return [];
  }
  const routes: AnnotatedRoute[] = [];
  for (const match of source.matchAll(ROUTE)) {
    const tags = tagsOf(match[1] ?? "");
    if (tags.permission === undefined && tags.oauthScopes === undefined) {
      continue;
    }
    routes.push({ method: match[2] ?? "GET", path, ...tags });
  }
  return routes;
}

function permissionExpr(key: string): string {
  return `permissions.${key}`;
}

function entryOf(route: AnnotatedRoute): string {
  const permission =
    route.permission === undefined
      ? undefined
      : permissionExpr(route.permission);
  const scopes =
    route.oauthScopes === undefined
      ? undefined
      : `[${route.oauthScopes.map((scope) => JSON.stringify(scope)).join(", ")}]`;
  const check =
    route.check === undefined ? undefined : JSON.stringify(route.check);
  if (permission !== undefined && scopes === undefined && check === undefined) {
    return permission;
  }
  const fields = [
    ...(permission === undefined ? [] : [`permission: ${permission}`]),
    ...(scopes === undefined ? [] : [`oauthScopes: ${scopes}`]),
    ...(check === undefined ? [] : [`enforcement: ${check}`]),
  ];
  return `{ ${fields.join(", ")} }`;
}

/** A module exporting `operations` from the annotated routes. */
export function operationsModule(routes: readonly AnnotatedRoute[]): string {
  const lines = routes.map(
    (route) =>
      `  ${JSON.stringify(`${route.method} ${route.path}`)}: ${entryOf(route)},`,
  );
  return `import { operationPermissions } from "permdock/openapi";
import { permissions } from "./permissions.ts";

export const operations = operationPermissions({
${lines.join("\n")}
});
`;
}
