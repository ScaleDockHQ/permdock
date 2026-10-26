import { resolve } from "node:path";

import type { DoctorInput } from "../shared/doctor-types.ts";
import type { PermDockConfig } from "../types.ts";

import { isRecord } from "../../core/compact.ts";
import { supabaseTenantClaim } from "../../supabase/budget.ts";
import { filesOf } from "../shared/doctor-files.ts";

const CONFIG_FILES = [
  "better-supabase.config.ts",
  "better-supabase.config.mts",
  "better-supabase.config.js",
  "better-supabase.config.mjs",
] as const;

/** The default export of the project's `better-supabase.config.*`, if it loads. */
export async function betterSupabaseConfig(
  input: Pick<DoctorInput, "cwd" | "files">,
): Promise<Record<string, unknown> | undefined> {
  const files = filesOf(input);
  const path = CONFIG_FILES.map((name) => resolve(input.cwd, name)).find(
    (file) => files.exists(file),
  );
  if (path === undefined) {
    return undefined;
  }
  try {
    // Lazy: preserve the CLI help startup graph; jiti loads only for a detected config.
    const { loadModule } = await import("./load.ts");
    const loaded = (await loadModule(path))["default"];
    return isRecord(loaded) ? loaded : undefined;
  } catch {
    return undefined;
  }
}

/** Resolve the hook default once for generation, inspection and doctor. */
export function betterSupabaseDefaults(
  config: PermDockConfig,
  detected: boolean,
): PermDockConfig {
  const hook = config.supabase?.hook;
  if (!detected || hook === undefined || hook.activeFrom !== undefined) {
    return config;
  }
  return {
    ...config,
    supabase: {
      ...config.supabase,
      hook: {
        ...hook,
        activeFrom: `app_metadata.${config.rls?.tenantClaim ?? supabaseTenantClaim}`,
      },
    },
  };
}
