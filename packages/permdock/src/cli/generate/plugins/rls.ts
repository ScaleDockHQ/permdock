import type { RlsConfig } from "../../types.ts";
import type { PermDockPlugin } from "../plugin.ts";

import { definePlugin } from "../plugin.ts";
import { pluginVersion } from "./version.ts";

/** Options captured by `rls()`. They replace `rls` in the config for this run. */
export type RlsPluginOptions = RlsConfig;

/**
 * The RLS plugin. The factory records options; the SQL generator loads on emit,
 * so importing `rls` does not load it.
 */
export function rls(options: RlsPluginOptions = {}): PermDockPlugin {
  const out = options.out ?? "permdock.sql";
  return definePlugin({
    name: "rls",
    version: pluginVersion(),
    inputs: () => ({ files: [], options }),
    plan: () => [{ id: "sql", out }],
    emit: async (task, _model, source) => {
      // Lazy: generate.ts pulls the SQL compiler, which importing rls() must not.
      const { filesForRls } = await import("./rls-files.ts");
      return filesForRls(task, options, source);
    },
  });
}
