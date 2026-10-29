import { resolve } from "node:path";

import type { DoctorInput } from "../shared/doctor-types.ts";
import type { PermDockConfig } from "../types.ts";

import { isRecord } from "../../core/compact.ts";
import { supabaseTenantClaim } from "../../supabase/budget.ts";
import { filesOf } from "../shared/doctor-files.ts";
import { workspaceDirs } from "../shared/workspace.ts";

const CONFIG_FILES = [
  "better-supabase.config.ts",
  "better-supabase.config.mts",
  "better-supabase.config.js",
  "better-supabase.config.mjs",
] as const;

/**
 * The default export of the nearest `better-supabase.config.*`, if it loads.
 * The search starts in `from` (default `cwd`), the directory of
 * `permdock.config.ts`, and goes up to the workspace root, so an app inside a
 * monorepo finds the root's config.
 */
export async function betterSupabaseConfig(
  input: Pick<DoctorInput, "cwd" | "files"> & { readonly from?: string },
): Promise<Record<string, unknown> | undefined> {
  const files = filesOf(input);
  const path = workspaceDirs(files, input.from ?? input.cwd)
    .flatMap((dir) => CONFIG_FILES.map((name) => resolve(dir, name)))
    .find((file) => files.exists(file));
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

function stringAt(
  value: unknown,
  ...path: readonly string[]
): string | undefined {
  let at = value;
  for (const key of path) {
    if (!isRecord(at)) return undefined;
    at = at[key];
  }
  return typeof at === "string" && at !== "" ? at : undefined;
}

/**
 * The claim better-supabase writes the active tenant to: `auth.tenant.claim` in
 * a grouped config, `claims.tenant` in a flat one, then `rls.tenantClaim` and
 * `tenant_id`.
 */
export function betterSupabaseTenantClaim(
  config: PermDockConfig,
  betterSupabase: Record<string, unknown>,
): string {
  return (
    stringAt(betterSupabase, "auth", "tenant", "claim") ??
    stringAt(betterSupabase, "claims", "tenant") ??
    config.rls?.tenantClaim ??
    supabaseTenantClaim
  );
}

/** better-supabase's server topic for authorization version changes. */
export const BETTER_SUPABASE_AUTHZ_TOPIC = "better_supabase:authz";

/**
 * Whether better-supabase's sessions block writes its own version table and the
 * `authz:<uid>` receive policy (`blocks.sessions.authzVersions`).
 */
export function betterSupabaseAuthzVersions(
  betterSupabase: Record<string, unknown>,
): boolean {
  const blocks = betterSupabase["blocks"];
  const sessions = isRecord(blocks) ? blocks["sessions"] : undefined;
  if (!isRecord(sessions)) return false;
  const options = sessions["options"];
  return (
    sessions["authzVersions"] === true ||
    (isRecord(options) && options["authzVersions"] === true)
  );
}

/** Resolve the hook defaults once for generation, inspection and doctor. */
export function betterSupabaseDefaults(
  config: PermDockConfig,
  betterSupabase: Record<string, unknown> | undefined,
): PermDockConfig {
  const hook = config.supabase?.hook;
  if (betterSupabase === undefined || hook === undefined) {
    return config;
  }
  const broadcast =
    hook.broadcast === false
      ? false
      : {
          topic: hook.broadcast?.topic ?? BETTER_SUPABASE_AUTHZ_TOPIC,
          receivePolicy:
            hook.broadcast?.receivePolicy ??
            !betterSupabaseAuthzVersions(betterSupabase),
        };
  return {
    ...config,
    supabase: {
      ...config.supabase,
      hook: {
        ...hook,
        activeFrom:
          hook.activeFrom ??
          `app_metadata.${betterSupabaseTenantClaim(config, betterSupabase)}`,
        broadcast,
      },
    },
  };
}
