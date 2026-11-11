import { join, resolve } from "node:path";

import type { DoctorFiles, DoctorInput } from "../shared/doctor-types.ts";
import type { PermDockConfig } from "../types.ts";

import { isRecord } from "../../core/compact.ts";
import { supabaseTenantClaim } from "../../supabase/budget.ts";
import { filesOf, readJson } from "../shared/doctor-files.ts";
import { workspaceDirs } from "../shared/workspace.ts";

const CONFIG_FILES = [
  "better-supabase.config.ts",
  "better-supabase.config.mts",
  "better-supabase.config.js",
  "better-supabase.config.mjs",
] as const;

type Lookup = Pick<DoctorInput, "cwd" | "files"> & {
  readonly from?: string;
  /** `betterSupabase.config` from `permdock.config.ts`, resolved against `cwd`. */
  readonly path?: string;
};

/**
 * The default export of the project's better-supabase config, if it loads.
 * `betterSupabase.config` in `permdock.config.ts` names it; without that the
 * search starts in `from` (default `cwd`), the directory of
 * `permdock.config.ts`, and goes up to the workspace root, so an app inside a
 * monorepo finds the root's config.
 */
export async function betterSupabaseConfig(
  input: Lookup,
): Promise<Record<string, unknown> | undefined> {
  return (await loadBetterSupabaseConfig(input)).config;
}

/**
 * `betterSupabaseConfig`, plus the error when the file exists but does not
 * load, for example while it reads a manifest PermDock has not written yet.
 */
export async function loadBetterSupabaseConfig(
  input: Lookup,
): Promise<{
  readonly config?: Record<string, unknown>;
  readonly failed?: { readonly path: string; readonly error: unknown };
}> {
  const files = filesOf(input);
  const path =
    input.path === undefined
      ? workspaceDirs(files, input.from ?? input.cwd)
          .flatMap((dir) => CONFIG_FILES.map((name) => resolve(dir, name)))
          .find((file) => files.exists(file))
      : [resolve(input.cwd, input.path)].find((file) => files.exists(file));
  if (path === undefined) {
    return {};
  }
  try {
    // Lazy: preserve the CLI help startup graph; jiti loads only for a detected config.
    const { loadModule } = await import("./load.ts");
    const loaded = (await loadModule(path))["default"];
    return isRecord(loaded) ? { config: loaded } : {};
  } catch (error) {
    return { failed: { path, error } };
  }
}

const DEPENDENCY_FIELDS = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const;

function declaresBetterSupabase(
  files: DoctorFiles,
  directory: string,
): boolean {
  const manifest = join(directory, "package.json");
  if (!files.exists(manifest)) {
    return false;
  }
  try {
    const parsed: unknown = readJson(files, manifest);
    return (
      isRecord(parsed) &&
      DEPENDENCY_FIELDS.some((field) => {
        const group = parsed[field];
        return isRecord(group) && Object.hasOwn(group, "better-supabase");
      })
    );
  } catch {
    return false;
  }
}

/** The patterns of `pnpm-workspace.yaml`'s `packages:` list or `workspaces`. */
function workspacePatterns(files: DoctorFiles, root: string): string[] {
  const patterns: string[] = [];
  const yaml = join(root, "pnpm-workspace.yaml");
  if (files.exists(yaml)) {
    let inPackages = false;
    for (const line of files.read(yaml).split("\n")) {
      if (/^packages\s*:/u.test(line)) {
        inPackages = true;
      } else if (/^\S/u.test(line)) {
        inPackages = false;
      } else if (inPackages) {
        const item = /^\s*-\s*["']?([^"'#\s]+)["']?/u.exec(line);
        if (item?.[1] !== undefined) {
          patterns.push(item[1]);
        }
      }
    }
  }
  const manifest = join(root, "package.json");
  if (files.exists(manifest)) {
    try {
      const parsed: unknown = readJson(files, manifest);
      const workspaces = isRecord(parsed) ? parsed["workspaces"] : undefined;
      const list = isRecord(workspaces) ? workspaces["packages"] : workspaces;
      if (Array.isArray(list)) {
        patterns.push(
          ...list.filter((entry): entry is string => typeof entry === "string"),
        );
      }
    } catch {
      // An unreadable manifest declares no workspaces.
    }
  }
  return patterns;
}

/**
 * The package directories a workspace pattern names: `dir/*`, `dir/**` or a
 * path.
 */
function packageDirs(
  files: DoctorFiles,
  root: string,
  pattern: string,
): readonly string[] {
  if (pattern.startsWith("!")) {
    return [];
  }
  const base = pattern.replace(/\/\*\*?$/u, "");
  const dir = resolve(root, base);
  if (base === pattern) {
    return [dir];
  }
  return files.isDirectory(dir)
    ? files
        .list(dir)
        .filter((name) => name !== "node_modules" && !name.startsWith("."))
        .map((name) => join(dir, name))
        .filter((entry) => files.isDirectory(entry))
    : [];
}

/**
 * Whether the nearest `package.json` (up to the workspace root) or a workspace
 * package depends on `better-supabase`, for a project whose config file sits in
 * another package than `permdock.config.ts`.
 */
export function betterSupabaseInstalled(
  input: Pick<DoctorInput, "cwd" | "files"> & { readonly from?: string },
): boolean {
  const files = filesOf(input);
  const dirs = workspaceDirs(files, input.from ?? input.cwd);
  if (dirs.some((dir) => declaresBetterSupabase(files, dir))) {
    return true;
  }
  const root = dirs.at(-1);
  return (
    root !== undefined &&
    workspacePatterns(files, root)
      .flatMap((pattern) => packageDirs(files, root, pattern))
      .some((dir) => declaresBetterSupabase(files, dir))
  );
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

/**
 * Resolve the hook defaults once for generation, inspection and doctor. With a
 * config, the hook reads its tenant claim and sessions block; with only the
 * dependency (`installed`), it broadcasts on better-supabase's topic and
 * changes nothing else.
 */
export function betterSupabaseDefaults(
  config: PermDockConfig,
  betterSupabase: Record<string, unknown> | undefined,
  installed = false,
): PermDockConfig {
  const hook = config.supabase?.hook;
  if (hook === undefined || (betterSupabase === undefined && !installed)) {
    return config;
  }
  const broadcast =
    hook.broadcast === false
      ? false
      : {
          topic: hook.broadcast?.topic ?? BETTER_SUPABASE_AUTHZ_TOPIC,
          receivePolicy:
            hook.broadcast?.receivePolicy ??
            (betterSupabase === undefined ||
              !betterSupabaseAuthzVersions(betterSupabase)),
        };
  return {
    ...config,
    supabase: {
      ...config.supabase,
      hook: {
        ...hook,
        ...(betterSupabase === undefined
          ? {}
          : {
              activeFrom:
                hook.activeFrom ??
                `app_metadata.${betterSupabaseTenantClaim(config, betterSupabase)}`,
            }),
        broadcast,
      },
    },
  };
}
