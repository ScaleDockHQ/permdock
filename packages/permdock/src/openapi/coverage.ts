import type { OperationLookup } from "./operations.ts";

import { isRecord } from "../core/compact.ts";
import { HTTP_METHODS } from "./operations.ts";

export type OperationCoverageOptions = {
  /**
   * Path templates whose operations act on a tenant, such as `/orgs/{orgId}`.
   * An operation under one needs an entry; others may go undeclared. A
   * `{param}` matches any parameter name.
   */
  readonly tenantPaths: readonly string[];
  /** A prefix the document's paths carry and the declared keys do not. */
  readonly base?: string;
};

export type OperationCoverage = {
  /**
   * Tenant-path operations of the document with no declared entry, as `METHOD
   * /path`.
   */
  readonly undeclared: readonly string[];
  /**
   * Declared entries that match no operation of the document, as `METHOD
   * /path`.
   */
  readonly stale: readonly string[];
};

function segmentsOf(path: string): readonly string[] {
  return path.split("/").filter((segment) => segment !== "");
}

/**
 * The template with every `{name}` reduced to `{}`, so parameter names may
 * differ.
 */
function shape(path: string): string {
  return segmentsOf(path)
    .map((segment) =>
      segment.startsWith("{") && segment.endsWith("}") ? "{}" : segment,
    )
    .join("/");
}

function under(path: string, prefixes: readonly string[]): boolean {
  const segments = shape(path).split("/");
  return prefixes.some((prefix) => {
    const head = shape(prefix).split("/");
    return head.every((segment, index) => segments[index] === segment);
  });
}

/**
 * Compares the declared operations with an OpenAPI document: a tenant-path
 * operation with no entry is `undeclared` (a gate denies it), an entry that
 * matches no operation is `stale`. `testOperationCoverage` and `permdock
 * doctor` (PD091) run this one function.
 */
export function operationCoverage(
  operations: OperationLookup,
  document: unknown,
  options: OperationCoverageOptions,
): OperationCoverage {
  const base = shape(options.base ?? "");
  const paths =
    isRecord(document) && isRecord(document["paths"]) ? document["paths"] : {};
  const inDocument = new Map<string, string>();
  for (const [path, item] of Object.entries(paths)) {
    if (!isRecord(item)) {
      continue;
    }
    const shaped = shape(path);
    const local =
      base !== "" && shaped.startsWith(`${base}/`)
        ? shaped.slice(base.length + 1)
        : shaped;
    for (const method of Object.keys(item)) {
      if (HTTP_METHODS.has(method.toUpperCase())) {
        inDocument.set(
          `${method.toUpperCase()} ${local}`,
          `${method.toUpperCase()} ${path}`,
        );
      }
    }
  }
  const declared = new Map(
    operations
      .entries()
      .map((entry) => [
        `${entry.method} ${shape(entry.path)}`,
        `${entry.method} ${entry.path}`,
      ]),
  );
  const undeclared = [...inDocument]
    .filter(
      ([key]) =>
        !declared.has(key) &&
        under(key.slice(key.indexOf(" ") + 1), options.tenantPaths),
    )
    .map(([, label]) => label);
  const stale = [...declared]
    .filter(([key]) => !inDocument.has(key))
    .map(([, label]) => label);
  return { undeclared, stale };
}
