import { cliVersion } from "../../core/version.ts";

/** The PermDock version, recorded on the plugin so it is part of a cache key. */
export function pluginVersion(): string {
  return cliVersion();
}
