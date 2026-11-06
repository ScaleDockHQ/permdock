import type { PermDockPlugin } from "../plugin.ts";
import type { RlsPluginOptions } from "./rls-options.ts";

import { definePlugin } from "../plugin.ts";
import { pluginVersion } from "./version.ts";

export type { RlsPluginOptions, RlsSeedsOption } from "./rls-options.ts";

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
