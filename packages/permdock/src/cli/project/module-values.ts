import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { parseSync } from "oxc-parser";

import type { ModuleKey } from "./config-shape.ts";
import type { LoadOptions } from "./load.ts";

import { listPermissions } from "../../index.ts";
import { configError } from "../core/errors.ts";
import { MODULE_KEYS, isModuleKey } from "./config-shape.ts";
import { asPermissionTree, loadModule, pickNamed } from "./load.ts";

/** The export each module key is read from, as `load.ts` reads it. */
const EXPORT_OF: Readonly<Record<ModuleKey, string>> = {
  policy: "policy",
  permissions: "permissions",
  operations: "operations",
};

const EXTENSIONS = [".ts", ".tsx", ".mts", ".js", ".mjs", ".jsx"] as const;

function isFile(path: string): boolean {
  return existsSync(path) && statSync(path).isFile();
}

/** A relative specifier resolved the way a TypeScript bundler resolves it. */
function resolveRelative(from: string, specifier: string): string | undefined {
  const base = resolve(dirname(from), specifier);
  const swapped = base.replace(/\.js$/u, ".ts").replace(/\.mjs$/u, ".mts");
  const candidates = [
    base,
    swapped,
    ...EXTENSIONS.map((extension) => `${base}${extension}`),
    ...EXTENSIONS.map((extension) => resolve(base, `index${extension}`)),
  ];
  return candidates.find(isFile);
}

function relativeImports(file: string): readonly string[] {
  const parsed = parseSync(file, readFileSync(file, "utf8"));
  return [
    ...new Set(
      parsed.module.staticImports
        .map((entry) => entry.moduleRequest.value)
        .filter((specifier) => specifier.startsWith(".")),
    ),
  ];
}

function fieldOf(value: object, key: string): unknown {
  return Reflect.get(value, key);
}

function leafKeys(value: object): string {
  try {
    return listPermissions(asPermissionTree(value))
      .map((leaf) => leaf.key)
      .toSorted()
      .join(",");
  } catch {
    return "";
  }
}

/**
 * Whether `exported` is the value the config passed. A module evaluated twice
 * (once natively, once through jiti, or fresh under `--watch`) yields a second
 * object, so a policy compares by fingerprint and a tree by its leaf keys.
 */
export function sameValue(
  key: ModuleKey,
  value: object,
  exported: unknown,
): boolean {
  if (exported === value) {
    return true;
  }
  if (exported === null || typeof exported !== "object") {
    return false;
  }
  switch (key) {
    case "policy": {
      const fingerprint = fieldOf(value, "fingerprint");
      return (
        typeof fingerprint === "string" &&
        fingerprint === fieldOf(exported, "fingerprint")
      );
    }
    case "permissions":
      return leafKeys(value) !== "" && leafKeys(value) === leafKeys(exported);
    case "operations": {
      const names = Object.keys(value).toSorted().join(",");
      return (
        names !== "" && names === Object.keys(exported).toSorted().join(",")
      );
    }
    default: {
      const exhaustive: never = key;
      return exhaustive;
    }
  }
}

/**
 * The module path, relative to `cwd`, of the module the config file imports
 * `value` from as its `policy`, `permissions` or `operations` export.
 */
async function traceModuleValue(input: {
  readonly cwd: string;
  readonly file: string;
  readonly display: string;
  readonly key: ModuleKey;
  readonly value: object;
  readonly options?: LoadOptions;
}): Promise<string> {
  const name = EXPORT_OF[input.key];
  for (const specifier of relativeImports(input.file)) {
    const abs = resolveRelative(input.file, specifier);
    if (abs === undefined) {
      continue;
    }
    // A sibling module that fails to load is not the one that exports the value.
    const mod = await loadModule(abs, input.options).catch(() => undefined);
    if (
      mod !== undefined &&
      sameValue(input.key, input.value, pickNamed(mod, [name]))
    ) {
      const path = relative(input.cwd, abs).replaceAll("\\", "/");
      return path.startsWith(".") ? path : `./${path}`;
    }
  }
  throw configError(
    `PermDock CLI: ${input.display}: ${input.key} is a value no relative import of the config exports as '${name}' or default; import it from its module, or set ${input.key} to the module path`,
  );
}

/**
 * `config` with each `policy`, `permissions` or `operations` value replaced by
 * the path of the module the config file imports it from, so every command
 * reads one form.
 */
export async function traceModuleValues(input: {
  readonly cwd: string;
  readonly file: string;
  readonly display: string;
  readonly config: Readonly<Record<string, unknown>>;
  readonly options?: LoadOptions;
}): Promise<Readonly<Record<string, unknown>>> {
  const traced: Record<string, unknown> = { ...input.config };
  for (const key of Object.keys(MODULE_KEYS)) {
    const value = input.config[key];
    if (!isModuleKey(key) || value === null || typeof value !== "object") {
      continue;
    }
    traced[key] = await traceModuleValue({ ...input, key, value });
  }
  return traced;
}
