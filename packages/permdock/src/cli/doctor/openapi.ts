import { resolve } from "node:path";

import type { OperationLookup } from "../../openapi/operations.ts";
import type { Project } from "../project/project.ts";
import type { DoctorFinding } from "../shared/doctor-types.ts";
import type { PermDockConfig } from "../types.ts";

import { isRecord } from "../../core/compact.ts";
import { operationCoverage } from "../../openapi/coverage.ts";
import { describeError } from "../core/errors.ts";
import { loadModule } from "../project/load.ts";

function isOperationPermissions(value: unknown): value is OperationLookup {
  return isRecord(value) && typeof value["entries"] === "function";
}

/** `path#export` splits at the last `#`; without one the export is `operations`. */
function splitSpecifier(specifier: string): {
  readonly path: string;
  readonly name: string;
} {
  const hash = specifier.lastIndexOf("#");
  return hash === -1
    ? { path: specifier, name: "operations" }
    : { path: specifier.slice(0, hash), name: specifier.slice(hash + 1) };
}

/**
 * PD091 runs only when the config names the operations, the documents and the
 * tenant paths.
 */
export function pd091Applies(config: PermDockConfig): boolean {
  return (
    config.openapi?.operations !== undefined &&
    config.openapi.tenantPaths !== undefined &&
    (config.openapi.doc?.length ?? 0) > 0
  );
}

/**
 * PD091: an operation under `openapi.tenantPaths` that `openapi.operations`
 * declares no entry for, so the HTTP gate denies it, or a declared entry that
 * matches no operation of an `openapi.doc` document. It runs
 * `operationCoverage`, the function `testOperationCoverage` runs.
 */
export async function pd091(
  project: Project,
): Promise<readonly DoctorFinding[]> {
  const openapi = project.config.openapi;
  if (openapi?.operations === undefined || openapi.tenantPaths === undefined) {
    return [];
  }
  const { path, name } = splitSpecifier(openapi.operations);
  let operations: unknown;
  try {
    operations = (await loadModule(resolve(project.cwd, path)))[name];
  } catch (error) {
    return [
      {
        code: "PD091",
        severity: "error",
        message: `openapi.operations '${openapi.operations}' does not load: ${describeError(error)}`,
        fix: "point openapi.operations at '<module>#<export>' of an operationPermissions(...) result",
        target: openapi.operations,
      },
    ];
  }
  if (!isOperationPermissions(operations)) {
    return [
      {
        code: "PD091",
        severity: "error",
        message: `openapi.operations '${openapi.operations}' is not an operationPermissions(...) result`,
        fix: "export the operationPermissions(...) result and name it as '<module>#<export>'",
        target: openapi.operations,
      },
    ];
  }
  const kernel: unknown = Reflect.get(operations, "kernel");
  const checked =
    openapi.enforcement === "kernel" && isOperationPermissions(kernel)
      ? kernel
      : operations;
  const findings: DoctorFinding[] = [];
  for (const doc of openapi.doc ?? []) {
    const abs = resolve(project.cwd, doc);
    if (!project.files.exists(abs)) {
      continue;
    }
    let document: unknown;
    try {
      document = JSON.parse(project.files.read(abs));
    } catch {
      findings.push({
        code: "PD091",
        severity: "error",
        message: `${doc} is not valid JSON, so operation coverage cannot be checked`,
        fix: "regenerate the document with permdock openapi",
        target: doc,
      });
      continue;
    }
    const coverage = operationCoverage(checked, document, {
      tenantPaths: openapi.tenantPaths,
      ...(openapi.base === undefined ? {} : { base: openapi.base }),
    });
    for (const label of coverage.undeclared) {
      const handler = handlerMode(operations, label);
      findings.push({
        code: "PD091",
        severity: "error",
        message: handler
          ? `${doc}: ${label} is under a tenant path and its entry is handler mode, so the handler must check it; the kernel map has no entry`
          : `${doc}: ${label} is under a tenant path and has no entry in ${openapi.operations}, so the gate denies it`,
        fix: handler
          ? `check ${label} in the handler, or set its enforcement to kernel`
          : `declare '${label.replace(openapi.base ?? "", "")}' in operationPermissions, or move it out of openapi.tenantPaths`,
        target: `${doc}:${label}`,
      });
    }
    for (const label of coverage.stale) {
      findings.push({
        code: "PD091",
        severity: "error",
        message: `${doc}: ${openapi.operations} declares ${label}, which the document does not contain`,
        fix: "remove the entry or regenerate the document",
        target: `${doc}:${label}`,
      });
    }
  }
  return findings;
}

/**
 * A document operation the full map marks `handler`, so the kernel map omits
 * it.
 */
function handlerMode(source: OperationLookup, label: string): boolean {
  const space = label.indexOf(" ");
  const method = label.slice(0, space);
  const path = shapeOf(label.slice(space + 1));
  return source
    .entries()
    .some(
      (entry) =>
        entry.method === method &&
        entry.enforcement === "handler" &&
        shapeOf(entry.path) === path,
    );
}

function shapeOf(path: string): string {
  return path
    .split("/")
    .filter((segment) => segment !== "")
    .map((segment) =>
      segment.startsWith("{") && segment.endsWith("}") ? "{}" : segment,
    )
    .join("/");
}
