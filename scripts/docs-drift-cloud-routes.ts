import { readFileSync } from "node:fs";
import { join } from "node:path";

const ENV = "/v1/environments/{env}";
const METHODS = ["get", "post", "put", "patch", "delete"] as const;
const COLLECTION = new Set(["GET", "POST"]);
const ITEM = new Set(["GET", "PUT", "PATCH", "DELETE"]);

function cells(row: string): readonly string[] {
  return row
    .slice(1, -1)
    .split(/(?<!\\)\|/u)
    .map((cell) => cell.trim().replaceAll("\\|", "|"));
}

function toOpenapi(path: string): string {
  return path
    .replace(/\?.*$/u, "")
    .replaceAll(/:(\w+)/gu, "{$1}")
    .replace(/\/\*$/u, "/{resource}");
}

/** The paths of one table cell: comma-separated, later ones relative to the environment. */
function cellPaths(cell: string): readonly string[] {
  const paths: string[] = [];
  for (const [, path = ""] of cell.matchAll(/`([^`]+)`/gu)) {
    paths.push(toOpenapi(path));
  }
  return paths.map((path, index) =>
    index === 0 || path.startsWith("/v1/") || path.startsWith("/scim/")
      ? path
      : `${ENV}${path}`,
  );
}

/** `METHOD path` pairs of the route tables under "### HTTP API"; `any` rows list the path only. */
function documentedRoutes(page: string): {
  readonly routes: ReadonlySet<string>;
  readonly anyPaths: ReadonlySet<string>;
} {
  const start = page.indexOf("### HTTP API");
  const section = page.slice(start, page.indexOf("\n### ", start + 1));
  const routes = new Set<string>();
  const anyPaths = new Set<string>();
  for (const row of section
    .split("\n")
    .filter((line) => line.startsWith("| `") || line.startsWith("| any"))) {
    const [methodCell = "", pathCell = ""] = cells(row);
    const methods: string[] = [];
    for (const [, method = ""] of methodCell.matchAll(/`([A-Z]+)`/gu)) {
      methods.push(method);
    }
    for (const raw of cellPaths(pathCell)) {
      if (methodCell === "any") {
        anyPaths.add(raw);
        continue;
      }
      if (!raw.endsWith("[/{id}]")) {
        for (const method of methods) {
          routes.add(`${method} ${raw}`);
        }
        continue;
      }
      const base = raw.slice(0, -"[/{id}]".length);
      for (const method of methods) {
        if (COLLECTION.has(method)) {
          routes.add(`${method} ${base}`);
        }
        if (ITEM.has(method)) {
          routes.add(`${method} ${base}/{id}`);
        }
      }
    }
  }
  return { routes, anyPaths };
}

/** Differences between the `cloud.mdx` route tables and `schemas/cloud-api-v1.json`. */
export function cloudRouteDrift(root: string): readonly string[] {
  const page = readFileSync(
    join(root, "apps", "docs", "content", "docs", "adapters", "cloud.mdx"),
    "utf8",
  );
  // SAFETY: the generated OpenAPI document; only `paths` and its method keys are read.
  const document = JSON.parse(
    readFileSync(
      join(root, "packages", "permdock", "schemas", "cloud-api-v1.json"),
      "utf8",
    ),
  ) as {
    readonly paths: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
  };
  const { routes, anyPaths } = documentedRoutes(page);
  const specified = new Set<string>();
  for (const [path, item] of Object.entries(document.paths)) {
    if (anyPaths.has(path)) {
      continue;
    }
    for (const method of METHODS) {
      if (item[method] !== undefined) {
        specified.add(`${method.toUpperCase()} ${path}`);
      }
    }
  }
  const missingPaths = [...anyPaths].filter(
    (path) => document.paths[path] === undefined,
  );
  return [
    ...[...routes]
      .filter((route) => !specified.has(route))
      .map(
        (route) =>
          `adapters/cloud.mdx lists ${route}, which schemas/cloud-api-v1.json does not`,
      ),
    ...[...specified]
      .filter((route) => !routes.has(route))
      .map(
        (route) =>
          `schemas/cloud-api-v1.json has ${route}, which the adapters/cloud.mdx route tables do not list`,
      ),
    ...missingPaths.map(
      (path) =>
        `adapters/cloud.mdx lists ${path}, which schemas/cloud-api-v1.json does not`,
    ),
  ];
}
