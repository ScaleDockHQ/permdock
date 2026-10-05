import { createJiti } from "jiti";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { Permission, PermissionTree, Policy } from "../index.ts";

import { listPermissions } from "../index.ts";

/**
 * Errors Node raises while resolving or parsing a module graph, before any of
 * its code runs, so loading it again through jiti cannot repeat a side effect.
 */
const NOT_NATIVE = new Set([
  "ERR_MODULE_NOT_FOUND",
  "ERR_UNKNOWN_FILE_EXTENSION",
  "ERR_UNSUPPORTED_DIR_IMPORT",
  "ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX",
  "ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING",
]);

function loadsWithJiti(error: unknown): boolean {
  if (error instanceof SyntaxError) {
    return true;
  }
  const code: unknown =
    error !== null && typeof error === "object" && "code" in error
      ? error.code
      : undefined;
  return typeof code === "string" && NOT_NATIVE.has(code);
}

export type LoadOptions = {
  /**
   * Evaluate the module and its project imports again. Node keeps the first
   * evaluation of an ESM graph for the life of the process, so a watcher
   * that imports natively never sees an edited file.
   */
  readonly fresh?: boolean;
};

function importWithJiti(abs: string, fresh: boolean): Promise<unknown> {
  const jiti = createJiti(import.meta.url, {
    interopDefault: false,
    jsx: true,
    tsconfigPaths: dirname(abs),
    moduleCache: !fresh,
    fsCache: !fresh,
  });
  return jiti.import(abs);
}

/**
 * Imports a project module the way its bundler would. Node's own `import()`
 * comes first; a module it cannot resolve or parse (tsconfig `paths`
 * aliases, extensionless relative imports, `enum`, TSX) loads through jiti
 * with the `paths` of the nearest `tsconfig.json` above it. Exports are
 * returned as written; `default` is not merged into the namespace.
 */
export async function loadModule(
  abs: string,
  options?: LoadOptions,
): Promise<Record<string, unknown>> {
  let loaded: unknown;
  if (options?.fresh === true) {
    loaded = await importWithJiti(abs, true);
  } else {
    try {
      loaded = await import(pathToFileURL(abs).href);
    } catch (error) {
      if (!loadsWithJiti(error)) {
        throw error;
      }
      loaded = await importWithJiti(abs, false);
    }
  }
  if (loaded === null || typeof loaded !== "object") {
    throw new Error(`PermDock CLI: module '${abs}' did not export an object`);
  }
  // SAFETY: checked to be a non-null object above; exports stay unknown.
  return loaded as Record<string, unknown>;
}

export function pickNamed(
  mod: Readonly<Record<string, unknown>>,
  names: readonly string[],
): unknown {
  for (const name of names) {
    if (name in mod) {
      return mod[name];
    }
  }
  return mod["default"];
}

export function asPermissionTree(value: unknown): PermissionTree {
  if (value === null || typeof value !== "object") {
    throw new Error(
      "PermDock CLI: permissions export is not a permission tree",
    );
  }
  // SAFETY: the project's configured permissions export, checked to be an object above.
  return value as PermissionTree;
}

export function asPolicy(value: unknown): Policy {
  if (
    value === null ||
    typeof value !== "object" ||
    !("roles" in value) ||
    !("permissions" in value)
  ) {
    throw new Error("PermDock CLI: policy export is not a Policy");
  }
  // SAFETY: the project's configured policy export, checked above for roles and permissions.
  return value as Policy;
}

export function leavesOf(tree: PermissionTree): readonly Permission[] {
  return listPermissions(tree);
}

/** The configured policy export, or `undefined` when unset or unloadable. */
export async function loadConfiguredPolicy(
  cwd: string,
  path: string | undefined,
  options?: LoadOptions,
): Promise<Policy | undefined> {
  if (path === undefined) {
    return undefined;
  }
  try {
    return asPolicy(
      pickNamed(await loadModule(resolve(cwd, path), options), ["policy"]),
    );
  } catch {
    return undefined;
  }
}
