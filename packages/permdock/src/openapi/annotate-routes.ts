export type AnnotatedRoute = {
  readonly method: string;
  readonly path: string;
  readonly permission?: string;
  readonly operationId?: string;
  readonly check?: "kernel" | "handler";
  readonly oauthScopes?: readonly string[];
};

/** Extra exports of a map read from an OpenAPI document. */
export type OperationsModuleExtras = {
  /** Operation labels by group name. */
  readonly groups?: Readonly<Record<string, readonly string[]>>;
  /** The tenant path parameter of each operation that has one, by label. */
  readonly tenants?: Readonly<Record<string, string>>;
};

function permissionExpr(key: string): string {
  const access = key
    .split(".")
    .map((part) =>
      /^[A-Za-z_$][\w$]*$/u.test(part)
        ? `.${part}`
        : `[${JSON.stringify(part)}]`,
    );
  return `permissions${access.join("")}`;
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
  if (
    permission !== undefined &&
    scopes === undefined &&
    check === undefined &&
    route.operationId === undefined
  ) {
    return permission;
  }
  const fields = [
    ...(route.operationId === undefined
      ? []
      : [`operationId: ${JSON.stringify(route.operationId)}`]),
    ...(permission === undefined ? [] : [`permission: ${permission}`]),
    ...(scopes === undefined ? [] : [`oauthScopes: ${scopes}`]),
    ...(check === undefined ? [] : [`enforcement: ${check}`]),
  ];
  return `{ ${fields.join(", ")} }`;
}

function exportRecord(
  name: string,
  value: Readonly<Record<string, unknown>>,
): string {
  return Object.keys(value).length === 0
    ? ""
    : `\nexport const ${name} = ${JSON.stringify(value, undefined, 2)} as const;\n`;
}

/** A module exporting `operations` from the annotated routes. */
export function operationsModule(
  routes: readonly AnnotatedRoute[],
  extras: OperationsModuleExtras = {},
): string {
  const lines = routes.map(
    (route) =>
      `  ${JSON.stringify(`${route.method} ${route.path}`)}: ${entryOf(route)},`,
  );
  return `import { operationPermissions } from "permdock/openapi";
import { permissions } from "./permissions.ts";

export const operations = operationPermissions({
${lines.join("\n")}
});
${exportRecord("operationGroups", extras.groups ?? {})}${exportRecord("operationTenants", extras.tenants ?? {})}`;
}
