import type { AnnotatedRoute } from "../../openapi/annotate-routes.ts";
import type { Estree } from "../codemod/ast.ts";

import { nameOf, nodes } from "../codemod/ast.ts";
import { parseSync } from "../core/optional.ts";

const METHODS: ReadonlySet<string> = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
  "QUERY",
]);

const TAG = /@(\w+)\s+([^\n*]+)/gu;

const DYNAMIC = /^\[{1,2}(?:\.\.\.)?([^\]]+)\]{1,2}$/u;

/**
 * The HTTP path of an App Router `route` file: `app/orgs/[org]/posts/route.ts`
 * is `/orgs/{org}/posts`, `app/route.ts` is `/`, and an optional catch-all
 * `[[...slug]]` is `{slug}`.
 */
export function routePath(file: string): string | undefined {
  const normalized = file.replaceAll("\\", "/");
  const match = /(?:^|\/)app(?:\/(.+))?\/route\.[cm]?[jt]sx?$/u.exec(
    normalized,
  );
  if (match === null) {
    return undefined;
  }
  const path = (match[1] ?? "")
    .split("/")
    .filter((segment) => segment !== "" && !segment.startsWith("("))
    .map((segment) => {
      const name = DYNAMIC.exec(segment)?.[1];
      return name === undefined ? segment : `{${name}}`;
    })
    .join("/");
  return `/${path}`;
}

function tagsOf(block: string): Omit<AnnotatedRoute, "method" | "path"> {
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

type Comment = {
  readonly type: string;
  readonly value: string;
  readonly start: number;
  readonly end: number;
};

/** The body of the JSDoc block that ends right before `at`, past white space. */
function docBefore(
  text: string,
  comments: readonly Comment[],
  at: number,
): string | undefined {
  const comment = comments.findLast((item) => item.end <= at);
  return comment?.type === "Block" &&
    comment.value.startsWith("*") &&
    text.slice(comment.end, at).trim() === ""
    ? comment.value
    : undefined;
}

/** The top-level statement that declares `name`, without `export`. */
function declarationOf(program: Estree, name: string): Estree | undefined {
  return nodes(program.body).find((statement) => {
    if (statement.type === "FunctionDeclaration") {
      return nameOf(statement.id ?? undefined) === name;
    }
    return (
      statement.type === "VariableDeclaration" &&
      nodes(statement.declarations).some(
        (item) => nameOf(item.id ?? undefined) === name,
      )
    );
  });
}

/** Each exported handler method with the statement whose JSDoc it takes. */
function handlers(
  program: Estree,
): { method: string; documented: readonly Estree[] }[] {
  const found: { method: string; documented: readonly Estree[] }[] = [];
  for (const statement of nodes(program.body)) {
    if (statement.type !== "ExportNamedDeclaration") {
      continue;
    }
    const declaration = statement.declaration;
    const declared =
      declaration?.type === "FunctionDeclaration"
        ? [nameOf(declaration.id ?? undefined)]
        : declaration?.type === "VariableDeclaration"
          ? nodes(declaration.declarations).map((item) =>
              nameOf(item.id ?? undefined),
            )
          : [];
    for (const name of declared) {
      if (name !== undefined && METHODS.has(name)) {
        found.push({ method: name, documented: [statement] });
      }
    }
    if (statement.source !== null && statement.source !== undefined) {
      continue;
    }
    for (const specifier of nodes(statement.specifiers)) {
      const method = nameOf(specifier.exported);
      const local = nameOf(specifier.local);
      if (method === undefined || !METHODS.has(method)) {
        continue;
      }
      const target =
        local === undefined ? undefined : declarationOf(program, local);
      found.push({
        method,
        documented: target === undefined ? [statement] : [target, statement],
      });
    }
  }
  return found;
}

/**
 * Operations declared on route handlers in `source`: each exported `GET`,
 * `POST`, … (a function, a `const`, or `export { handler as GET }`) takes the
 * JSDoc block directly above its declaration. A file the parser rejects
 * declares none.
 */
export function routesFromSource(
  file: string,
  source: string,
): readonly AnnotatedRoute[] {
  const path = routePath(file);
  if (path === undefined) {
    return [];
  }
  const parsed = parseSync(file, source);
  const failed = parsed.errors.some((error) => {
    // `Severity` is an ambient const enum, which isolated modules cannot reference.
    const severity: string = error.severity;
    return severity === "Error";
  });
  if (failed) {
    return [];
  }
  // SAFETY: Estree is an all-optional view of the Oxc program, whose nodes all carry `start` and `end`.
  const program = parsed.program as unknown as Estree;
  const comments: readonly Comment[] = parsed.comments;
  const routes: AnnotatedRoute[] = [];
  for (const { method, documented } of handlers(program)) {
    const doc = documented
      .map((node) => docBefore(source, comments, node.start))
      .find((item) => item !== undefined);
    const tags = tagsOf(doc ?? "");
    if (tags.permission === undefined && tags.oauthScopes === undefined) {
      continue;
    }
    routes.push({ method, path, ...tags });
  }
  return routes;
}
