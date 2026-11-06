import type { PermDockPlugin } from "../plugin.ts";

import { definePlugin } from "../plugin.ts";
import { pluginVersion } from "./version.ts";

export type PowerSyncPluginOptions = { readonly out?: string };

/** Sync Streams from the policy. The YAML writer loads on emit. */
export function powersync(
  options: PowerSyncPluginOptions = {},
): PermDockPlugin {
  const out = options.out ?? "sync-config.yaml";
  return definePlugin({
    name: "powersync",
    version: pluginVersion(),
    after: ["rls"],
    inputs: () => ({ files: [], options }),
    plan: () => [{ id: "sync", out }],
    emit: async (task, _model, source) => {
      if (source === undefined) {
        return [];
      }
      // Lazy: the stream compiler loads only when this plugin emits.
      const { powersyncFiles } = await import("../../powersync/powersync.ts");
      return powersyncFiles(source.policy, source.config, task.out).files.map(
        (file) => ({ path: file.path, contents: file.text }),
      );
    },
  });
}
