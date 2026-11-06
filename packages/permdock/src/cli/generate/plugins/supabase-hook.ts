import type { PermDockPlugin } from "../plugin.ts";

import { definePlugin } from "../plugin.ts";
import { pluginVersion } from "./version.ts";

export type SupabaseHookPluginOptions = { readonly out?: string };

/** The Custom Access Token hook. The hook SQL loads on emit. */
export function supabaseHook(
  options: SupabaseHookPluginOptions = {},
): PermDockPlugin {
  return definePlugin({
    name: "supabaseHook",
    version: pluginVersion(),
    after: ["rls"],
    inputs: () => ({ files: [], options }),
    plan: () => [
      { id: "hook", out: options.out ?? "supabase/permdock-hook.sql" },
    ],
    emit: async (task, model, source) => {
      if (source === undefined) {
        return [];
      }
      // Lazy: the hook writer loads only when this plugin emits.
      const { supabaseHookSql } =
        await import("../../supabase-hook/supabase-hook.ts");
      return [
        {
          path: task.out,
          contents: supabaseHookSql(model.scopes, source.config).sql,
        },
      ];
    },
  });
}
