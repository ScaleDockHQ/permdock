import { existsSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

import type { PermDockPlugin } from "../generate/plugin.ts";
import type { PermDockConfig } from "../types.ts";
import type { ConfigChecks, PermDockConfigInput } from "./config-checks.ts";
import type { ParsedConfig } from "./config-schema.ts";

import { isRecord } from "../../core/compact.ts";
import { supabaseTenantClaim } from "../../supabase/budget.ts";
import { CliError } from "../core/errors.ts";
import {
  betterSupabaseDefaults,
  betterSupabaseInstalled,
  loadBetterSupabaseConfig,
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
  const lookup = {
    cwd,
    from: dirname(path),
    ...(parsed.config.betterSupabase?.config === undefined
      ? {}
      : { path: parsed.config.betterSupabase.config }),
  };
  const betterSupabase = await loadBetterSupabaseConfig(lookup);
  const { failed } = betterSupabase;
  return {
    ...parsed,
    // A config that does not load still counts, so the hook defaults do not
    // depend on whether the files it reads exist yet.
    config: betterSupabaseDefaults(
      withPluginOutputs(parsed.config),
      failed === undefined ? betterSupabase.config : {},
      betterSupabaseInstalled(lookup),
    ),
    warnings:
      failed === undefined || parsed.config.supabase?.hook === undefined
        ? parsed.warnings
        : [...parsed.warnings, unloadedWarning(cwd, failed, parsed.config)],
    file: path,
  };
}

function foldsConfig(
  plugin: unknown,
): plugin is Required<Pick<PermDockPlugin, "config">> {
  return isRecord(plugin) && typeof plugin["config"] === "function";
}

/** `config` with each configured plugin's output options folded in, in order. */
export function withPluginOutputs(config: PermDockConfig): PermDockConfig {
  let folded = config;
  for (const plugin of config.plugins ?? []) {
    if (foldsConfig(plugin)) {
      folded = plugin.config(folded);
    }
  }
  return folded;
}

function unloadedWarning(
  cwd: string,
  failed: { readonly path: string; readonly error: unknown },
  config: PermDockConfig,
): string {
  const file = relative(cwd, failed.path).replaceAll("\\", "/");
  const reason =
    failed.error instanceof Error ? failed.error.message : String(failed.error);
  const claim = config.rls?.tenantClaim ?? supabaseTenantClaim;
  return `[better_supabase_config] ${file} did not load (${reason}); the hook reads app_metadata.${claim} unless supabase.hook.activeFrom is set`;
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
