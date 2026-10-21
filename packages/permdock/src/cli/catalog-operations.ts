import { existsSync } from "node:fs";
import { resolve } from "node:path";

import type { LoadOptions } from "./project/load.ts";
import type { CatalogOperation } from "./types.ts";

import { isRecord } from "../core/compact.ts";
import { isOperationRisk } from "../core/operation-risks.ts";
import { isOperationEffect } from "../core/operations.ts";
import { isPermission } from "../core/permission-registry.ts";
import { configError } from "./core/errors.ts";
import { rel } from "./files.ts";
import { loadModule, pickNamed } from "./project/load.ts";

function metaOf(name: string, value: unknown): CatalogOperation["meta"] {
  const fail = (field: string): never => {
    throw configError(
      `PermDock CLI: operations.${name}.meta${field} is invalid`,
    );
  };
  if (!isRecord(value)) {
    return fail("");
  }
  const { risk, effects, title } = value;
  if (risk !== undefined && !isOperationRisk(risk)) {
    return fail(".risk");
  }
  if (
    effects !== undefined &&
    (!Array.isArray(effects) || !effects.every(isOperationEffect))
  ) {
    return fail(".effects");
  }
  if (title !== undefined && typeof title !== "string") {
    return fail(".title");
  }
  return {
    ...(risk === undefined ? {} : { risk }),
    ...(effects === undefined ? {} : { effects }),
    ...(title === undefined ? {} : { title }),
  };
}

/**
 * The catalog entries of a `defineOperations` map, in definition order. Throws
 * for a value that is not one, such as a module that exports the definitions
 * object instead of the map.
 */
export function catalogOperations(value: unknown): readonly CatalogOperation[] {
  if (!isRecord(value)) {
    throw configError(
      "PermDock CLI: operations export is not an operation map",
    );
  }
  const out: CatalogOperation[] = [];
  for (const name of Object.keys(value)) {
    const operation = value[name];
    if (
      !isRecord(operation) ||
      operation["name"] !== name ||
      !isPermission(operation["permission"])
    ) {
      throw configError(
        `PermDock CLI: operations.${name} is not an operation; export the defineOperations result`,
      );
    }
    const results: unknown = operation["results"];
    if (results !== undefined && !isPermission(results)) {
      throw configError(
        `PermDock CLI: operations.${name}.results is not a permission`,
      );
    }
    out.push({
      name,
      permission: operation["permission"].key,
      ...(results === undefined ? {} : { results: results.key }),
      meta: metaOf(name, operation["meta"]),
    });
  }
  return out;
}

/**
 * The configured operations module's catalog entries; `undefined` without one.
 * Throws when it is missing or does not load.
 */
export async function loadConfiguredOperations(
  cwd: string,
  path: string | undefined,
  options?: LoadOptions,
): Promise<readonly CatalogOperation[] | undefined> {
  if (path === undefined) {
    return undefined;
  }
  const abs = resolve(cwd, path);
  if (!existsSync(abs)) {
    throw configError(
      `PermDock CLI: operations module not found: ${rel(cwd, abs)}`,
    );
  }
  const mod = await loadModule(abs, options);
  return catalogOperations(pickNamed(mod, ["operations"]));
}
