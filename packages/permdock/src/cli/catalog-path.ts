import { resolve } from "node:path";

import type { PermDockConfig } from "./types.ts";

/**
 * The absolute path `permdock collect` writes the catalog to: `collect.out`,
 * then `catalog.out`, then `permissions.catalog.json`, resolved against `cwd`.
 * `out` overrides the config, as `collect --out` does.
 */
export function catalogPath(
  config: PermDockConfig,
  cwd: string,
  out?: string,
): string {
  return resolve(
    cwd,
    out ??
      config.collect?.out ??
      config.catalog?.out ??
      "permissions.catalog.json",
  );
}
