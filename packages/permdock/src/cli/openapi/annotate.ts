import { globSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isMap, parseDocument } from "yaml";

import type { AnnotatedRoute } from "../../openapi/annotate-routes.ts";
import type { CommandResult, Finding } from "../core/result.ts";
import type { EmittedFile } from "../generate/plugin.ts";
import type { CliIo } from "../types.ts";

import {
  operationsModule,
  routesFromSource,
} from "../../openapi/annotate-routes.ts";
import { configError } from "../core/errors.ts";
import { rel } from "../files.ts";

function routesOf(cwd: string, routes: string): readonly AnnotatedRoute[] {
  return globSync(routes, { cwd })
    .toSorted()
    .flatMap((file) =>
      routesFromSource(file, readFileSync(resolve(cwd, file), "utf8")),
    );
}

export function operationsFile(
  cwd: string,
  routes: string,
  out: string,
): readonly EmittedFile[] {
  return [{ path: out, contents: operationsModule(routesOf(cwd, routes)) }];
}

/**
 * `spec` with `x-authorization` and `x-oauth-scopes` set on each operation a
 * route declares, YAML comments kept; a route the spec lacks is a finding.
 */
function specWithRoutes(
  text: string,
  routes: readonly AnnotatedRoute[],
  json: boolean,
): { readonly text: string; readonly findings: readonly Finding[] } {
  const document = parseDocument(text);
  if (!isMap(document.get("paths"))) {
    throw configError(
      "PermDock CLI: --write-spec must be a JSON or YAML OpenAPI document with paths",
    );
  }
  const findings: Finding[] = [];
  for (const route of routes) {
    const method = route.method.toLowerCase();
    const at = ["paths", route.path, method];
    if (!isMap(document.getIn(at))) {
      findings.push({
        code: "operation-not-in-spec",
        severity: "warning",
        message: `${route.method} ${route.path} has route comments but no operation in the spec`,
        fix: "Add the operation to the spec, or remove the comments",
      });
      continue;
    }
    if (route.permission !== undefined) {
      document.setIn(
        [...at, "x-authorization"],
        route.check === undefined
          ? route.permission
          : document.createNode({
              permission: route.permission,
              check: route.check,
            }),
      );
    }
    if (route.oauthScopes !== undefined) {
      document.setIn(
        [...at, "x-oauth-scopes"],
        document.createNode([...route.oauthScopes]),
      );
    }
  }
  return {
    text: json
      ? `${JSON.stringify(document.toJS({ maxAliasCount: 50 }), null, 2)}\n`
      : document.toString(),
    findings,
  };
}

export function runAnnotate(input: {
  readonly cwd: string;
  readonly routes: string;
  readonly out: string;
  readonly writeSpec?: string;
  readonly io: CliIo;
}): CommandResult {
  const found = routesOf(input.cwd, input.routes);
  if (input.writeSpec !== undefined) {
    const path = resolve(input.cwd, input.writeSpec);
    const written = specWithRoutes(
      readFileSync(path, "utf8"),
      found,
      path.endsWith(".json"),
    );
    writeFileSync(path, written.text);
    return {
      code: 0,
      output: [
        ...written.findings.map(
          (finding) =>
            `${finding.severity}  ${finding.code}  ${finding.message}`,
        ),
        `wrote x-authorization and x-oauth-scopes for ${String(found.length)} operations into ${rel(input.cwd, path)}`,
      ].join("\n"),
      findings: written.findings,
    };
  }
  const contents = operationsModule(found);
  const out = resolve(input.cwd, input.out);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, contents);
  return {
    code: 0,
    output: `wrote ${rel(input.cwd, out)} (${String(found.length)} operations)\n`,
  };
}
