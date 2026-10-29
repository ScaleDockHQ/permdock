import { existsSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

import type { PermDockConfig } from "../types.ts";
import type { ConfigChecks, PermDockConfigInput } from "./config-checks.ts";
import type { ParsedConfig } from "./config-schema.ts";

import { isRecord } from "../../core/compact.ts";
import { CliError } from "../core/errors.ts";
import {
  betterSupabaseConfig,
  betterSupabaseDefaults,
} from "./better-supabase.ts";
import { parseConfig } from "./config-schema.ts";
import { MODULE_KEYS } from "./config-shape.ts";

const CONFIG_FILES = [
  "permdock.config.ts",
  "permdock.config.mts",
  "permdock.config.js",
  "permdock.config.mjs",
] as const;

/**
 * Types a `permdock.config.ts`. Pass the `policy` value rather than its path,
 * and resource, scope, action and permission names in the config are checked
 * against it.
 */
export function defineConfig<const C extends PermDockConfigInput>(
  config: C & ConfigChecks<C>,
): C {
  return config;
}

export function isConfigFile(name: string): boolean {
  return CONFIG_FILES.some((file) => file === name);
}

export type LoadedConfig = ParsedConfig & {
  /** The config file read, or `undefined` when there is none. */
  readonly file: string | undefined;
};

export async function readConfig(
  cwd: string,
  fromFlag?: string,
  options?: { readonly fresh?: boolean },
): Promise<LoadedConfig> {
  const path =
    fromFlag !== undefined && fromFlag !== ""
      ? resolve(cwd, fromFlag)
      : CONFIG_FILES.map((name) => resolve(cwd, name)).find((file) =>
          existsSync(file),
        );
  if (path === undefined) {
    return { config: {}, warnings: [], file: undefined };
  }
  if (!existsSync(path)) {
    throw new CliError(
      "usage",
      `PermDock CLI: config file not found: ${path}`,
      { code: "config_not_found" },
    );
  }
  // Lazy: jiti and the core load only when there is a config file to read.
  const { loadModule, pickNamed } = await import("./load.ts");
  const mod = await loadModule(path, options);
  const display = relative(cwd, path).replaceAll("\\", "/");
  const raw = pickNamed(mod, ["default"]);
  const parsed = parseConfig(
    hasModuleValue(raw)
      ? await traceValues(cwd, path, display, raw, options)
      : raw,
    display,
  );
  return {
    ...parsed,
    config: betterSupabaseDefaults(
      parsed.config,
      await betterSupabaseConfig({ cwd, from: dirname(path) }),
    ),
    file: path,
  };
}

function hasModuleValue(
  raw: unknown,
): raw is Readonly<Record<string, unknown>> {
  return (
    isRecord(raw) && Object.keys(MODULE_KEYS).some((key) => isRecord(raw[key]))
  );
}

async function traceValues(
  cwd: string,
  file: string,
  display: string,
  config: Readonly<Record<string, unknown>>,
  options: { readonly fresh?: boolean } | undefined,
): Promise<Readonly<Record<string, unknown>>> {
  // Lazy: oxc-parser loads only for a config that passes a value.
  const { traceModuleValues } = await import("./module-values.ts");
  return traceModuleValues({
    cwd,
    file,
    display,
    config,
    ...(options === undefined ? {} : { options }),
  });
}

export async function loadConfig(
  cwd: string,
  fromFlag?: string,
  options?: { readonly fresh?: boolean },
): Promise<PermDockConfig> {
  return (await readConfig(cwd, fromFlag, options)).config;
}

export function resolveCwd(cwd: string | undefined, fallback: string): string {
  return cwd === undefined ? fallback : resolve(fallback, cwd);
}
