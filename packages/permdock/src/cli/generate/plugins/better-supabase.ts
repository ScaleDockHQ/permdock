import type { PermDockPlugin } from "../plugin.ts";

import { definePlugin, schemaInputs } from "../plugin.ts";
import { pluginVersion } from "./version.ts";

export type BetterSupabasePluginOptions = { readonly manifest?: string };

/**
 * better-supabase sits on the hook. It emits no SQL of its own: the provider
 * reads the manifest the hook writes.
 */
export function betterSupabase(
  options: BetterSupabasePluginOptions = {},
): PermDockPlugin {
  return definePlugin({
    name: "betterSupabase",
    version: pluginVersion(),
    after: ["supabaseHook"],
    inputs: (ctx) => schemaInputs(ctx, options),
    plan: () => [],
    emit: () => [],
  });
}
