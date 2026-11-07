import type { PermDockPlugin } from "../generate/plugin.ts";
import type { GenKindPluginOptions } from "../generate/plugins/gen-kind.ts";

import { kindPlugin } from "../generate/plugins/gen-kind.ts";

export type { GenKindPluginOptions };

/** `permdock/react` bound to the policy's vocabulary. Carries `"use client"`. */
export function reactHooks(options: GenKindPluginOptions = {}): PermDockPlugin {
  return kindPlugin("react", options);
}

/** `permdock/vue` bound to the policy's vocabulary. */
export function vueHooks(options: GenKindPluginOptions = {}): PermDockPlugin {
  return kindPlugin("vue", options);
}

/** `permdock/svelte` bound to the policy's vocabulary. */
export function svelteHooks(
  options: GenKindPluginOptions = {},
): PermDockPlugin {
  return kindPlugin("svelte", options);
}

/** `permdock/solid` bound to the policy's vocabulary. */
export function solidHooks(options: GenKindPluginOptions = {}): PermDockPlugin {
  return kindPlugin("solid", options);
}
