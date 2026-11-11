import type { SupabaseSchemas } from "../../types.ts";
import type { PermDockPlugin } from "../plugin.ts";

import { definePlugin, quietIo, schemaInputs, withHookOut } from "../plugin.ts";
import { outcomeNotes } from "./supabase-outcome.ts";
import { pluginVersion } from "./version.ts";

export type SupabaseHookPluginOptions = {
  readonly out?: string;
  readonly schemas?: SupabaseSchemas;
  readonly schema?: string;
  readonly grantsOut?: string;
  readonly activeFrom?: string;
  readonly budget?: string;
};

/** The Custom Access Token hook. The hook SQL loads on emit. */
export function supabaseHook(
  options: SupabaseHookPluginOptions = {},
): PermDockPlugin {
  return definePlugin({
    name: "supabaseHook",
    version: pluginVersion(),
    conflicts: ["supabase"],
    after: ["rls"],
    inputs: (ctx) => schemaInputs(ctx, options),
    plan: () => [
      { id: "hook", out: options.out ?? "supabase/permdock-hook.sql" },
    ],
    config: (config) => withHookOut(config, options.out),
    emit: async (_task, _model, source) => {
      if (source === undefined) {
        return [];
      }
      // Lazy: the hook writer loads only when this plugin emits.
      const { runSupabase } =
        await import("../../supabase-hook/supabase-hook.ts");
      const outcome = await runSupabase({
        cwd: source.cwd,
        config: source.config,
        rest: ["hook", "generate"],
        check: false,
        io: quietIo,
        ...(options.out === undefined ? {} : { out: options.out }),
        ...(options.schemas === undefined ? {} : { schemas: options.schemas }),
        ...(options.schema === undefined ? {} : { schema: options.schema }),
        ...(options.grantsOut === undefined
          ? {}
          : { grantsOut: options.grantsOut }),
        ...(options.activeFrom === undefined
          ? {}
          : { activeFrom: options.activeFrom }),
        ...(options.budget === undefined ? {} : { budget: options.budget }),
        ...(source.db === undefined ? {} : { db: source.db }),
      });
      return outcomeNotes(outcome);
    },
  });
}
