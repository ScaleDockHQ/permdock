import type { SupabaseSchemas } from "../../types.ts";
import type { PermDockPlugin } from "../plugin.ts";
import type { RlsPluginOptions } from "./rls-options.ts";

import { CliError } from "../../core/errors.ts";
import { MANIFEST_FILE } from "../../manifest-json.ts";
import { definePlugin, noted, schemaInputs } from "../plugin.ts";
import { pluginVersion } from "./version.ts";

/** The Custom Access Token hook the plugin writes; `false` skips it. */
export type SupabaseHookOption =
  | false
  | {
      readonly out?: string;
      readonly schema?: string;
      readonly activeFrom?: string;
      readonly budget?: string;
    };

/**
 * Options for `supabase()`: the `rls()` options with the `supabase` dialect,
 * plus the hook and the manifest. `out` is the RLS SQL file.
 */
export type SupabasePluginOptions = Omit<RlsPluginOptions, "dialect"> & {
  readonly schemas?: SupabaseSchemas;
  readonly hook?: SupabaseHookOption;
  /** The manifest file, `permdock.manifest.json` by default; `false` skips it. */
  readonly manifest?: string | false;
};

const quiet = {
  stdout(): void {
    return undefined;
  },
  stderr(): void {
    return undefined;
  },
};

/**
 * One plugin for a Supabase project: RLS SQL, the hook SQL and the manifest. It
 * emits what `rls()`, `supabaseHook()` and `permdock supabase inspect` emit
 * together, and it replaces them. The generators load on emit.
 */
export function supabase(options: SupabasePluginOptions = {}): PermDockPlugin {
  const { hook, manifest, ...rlsOptions } = options;
  const sql = options.out ?? "permdock.sql";
  const hookOut = hook === false ? undefined : hook?.out;
  const manifestOut =
    manifest === false ? undefined : (manifest ?? MANIFEST_FILE);
  return definePlugin({
    name: "supabase",
    version: pluginVersion(),
    conflicts: ["rls", "supabaseHook"],
    inputs: (ctx) => schemaInputs(ctx, options),
    plan: () => [
      { id: "sql", out: sql },
      ...(hook === false
        ? []
        : [{ id: "hook", out: hookOut ?? "supabase/permdock-hook.sql" }]),
      ...(manifestOut === undefined
        ? []
        : [{ id: "manifest", out: manifestOut }]),
    ],
    emit: async (task, _model, source) => {
      if (task.id === "sql") {
        // Lazy: the SQL compiler loads only when this plugin emits.
        const { filesForRls } = await import("./rls-files.ts");
        return filesForRls(
          task,
          { ...rlsOptions, dialect: "supabase" },
          source,
        );
      }
      if (source === undefined) {
        return [];
      }
      // Lazy: the hook and manifest writer loads only when this plugin emits.
      const { runSupabase } =
        await import("../../supabase-hook/supabase-hook.ts");
      const hookOptions = hook === false || hook === undefined ? {} : hook;
      const outcome = await runSupabase({
        cwd: source.cwd,
        config: source.config,
        rest: task.id === "hook" ? ["hook", "generate"] : ["inspect"],
        check: false,
        io: quiet,
        ...(task.id === "manifest"
          ? { out: task.out }
          : hookOut === undefined
            ? {}
            : { out: hookOut }),
        ...(options.schemas === undefined ? {} : { schemas: options.schemas }),
        ...(options.grantsOut === undefined
          ? {}
          : { grantsOut: options.grantsOut }),
        ...(hookOptions.schema === undefined
          ? {}
          : { schema: hookOptions.schema }),
        ...(hookOptions.activeFrom === undefined
          ? {}
          : { activeFrom: hookOptions.activeFrom }),
        ...(hookOptions.budget === undefined
          ? {}
          : { budget: hookOptions.budget }),
        ...(source.db === undefined ? {} : { db: source.db }),
      });
      if (outcome.code !== 0) {
        throw new CliError(
          outcome.code === 2 ? "usage" : "failed",
          outcome.output,
          { code: outcome.code === 2 ? "config_invalid" : "check_failed" },
        );
      }
      return noted([], outcome.output === "" ? [] : outcome.output.split("\n"));
    },
  });
}
