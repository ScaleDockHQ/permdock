import { existsSync } from "node:fs";
import { resolve } from "node:path";

import type { PermDockConfig } from "./types.ts";

const CONFIG_FILES = [
  "permdock.config.ts",
  "permdock.config.mts",
  "permdock.config.js",
  "permdock.config.mjs",
] as const;

export function defineConfig<T extends PermDockConfig>(config: T): T {
  return config;
}

export async function loadConfig(
  cwd: string,
  fromFlag?: string,
): Promise<PermDockConfig> {
  const path = fromFlag
    ? resolve(cwd, fromFlag)
    : CONFIG_FILES.map((name) => resolve(cwd, name)).find((file) =>
        existsSync(file),
      );
  if (path === undefined) {
    return {};
  }
  if (!existsSync(path)) {
    throw new Error(`PermDock CLI: config file not found: ${path}`);
  }
  // Lazy: jiti and the core load only when there is a config file to read.
  const { loadModule, pickNamed } = await import("./load.ts");
  const mod = await loadModule(path);
  const value = pickNamed(mod, ["default"]);
  if (value === null || typeof value !== "object") {
    return {};
  }
  // SAFETY: the project's own permdock config default export, checked to be an object above.
  return value as PermDockConfig;
}

export function resolveCwd(cwd: string | undefined, fallback: string): string {
  return cwd === undefined ? fallback : resolve(fallback, cwd);
}
