import type { SupabaseSchemas } from "../../types.ts";
import type { PermDockPlugin } from "../plugin.ts";
import type { RlsPluginOptions } from "./rls-options.ts";

import { compact } from "../../../core/compact.ts";
import { definePlugin, quietIo, schemaInputs } from "../plugin.ts";
import { outcomeNotes } from "./supabase-outcome.ts";
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

// manifest-json.ts shares a chunk that loads pg, which a plugin entry must not.
const MANIFEST_FILE = "permdock.manifest.json";

type SupabaseOverrides = {
  readonly out?: string;
  readonly schemas?: SupabaseSchemas;
  readonly grantsOut?: string;
  readonly schema?: string;
  readonly activeFrom?: string;
  readonly budget?: string;
  readonly db?: string;
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
        io: quietIo,
        ...compact<SupabaseOverrides>({
          out: task.id === "manifest" ? task.out : hookOut,
          schemas: options.schemas,
          grantsOut: options.grantsOut,
          schema: hookOptions.schema,
          activeFrom: hookOptions.activeFrom,
          budget: hookOptions.budget,
          db: source.db,
        }),
      });
      return outcomeNotes(outcome);
    },
  });
}
