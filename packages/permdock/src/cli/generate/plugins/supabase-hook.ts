import type { SupabaseSchemas } from "../../types.ts";
import type { PermDockPlugin } from "../plugin.ts";

import { CliError } from "../../core/errors.ts";
import { definePlugin } from "../plugin.ts";
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
    after: ["rls"],
    inputs: () => ({ files: [], options }),
    plan: () => [
      { id: "hook", out: options.out ?? "supabase/permdock-hook.sql" },
    ],
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
        io: {
          stdout() {
            return undefined;
          },
          stderr() {
            return undefined;
          },
        },
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
      });
      if (outcome.code !== 0) {
        throw new CliError(
          outcome.code === 2 ? "usage" : "failed",
          outcome.output,
          { code: outcome.code === 2 ? "config_invalid" : "check_failed" },
        );
      }
      return [];
    },
  });
}
