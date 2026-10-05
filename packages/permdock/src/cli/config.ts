import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";

import type { PermDockConfig } from "./types.ts";

import { type ParsedConfig, parseConfig } from "./config-schema.ts";

const CONFIG_FILES = [
  "permdock.config.ts",
  "permdock.config.mts",
  "permdock.config.js",
  "permdock.config.mjs",
] as const;

export function defineConfig<T extends PermDockConfig>(config: T): T {
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
  const path = fromFlag
    ? resolve(cwd, fromFlag)
    : CONFIG_FILES.map((name) => resolve(cwd, name)).find((file) =>
        existsSync(file),
      );
  if (path === undefined) {
    return { config: {}, warnings: [], file: undefined };
  }
  if (!existsSync(path)) {
    throw new Error(`PermDock CLI: config file not found: ${path}`);
  }
  // Lazy: jiti and the core load only when there is a config file to read.
  const { loadModule, pickNamed } = await import("./load.ts");
  const mod = await loadModule(path, options);
  return {
    ...parseConfig(
      pickNamed(mod, ["default"]),
      relative(cwd, path).replaceAll("\\", "/"),
    ),
    file: path,
  };
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
