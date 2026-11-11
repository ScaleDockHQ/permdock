import type { SqlMembershipSource } from "../../supabase/sources.ts";
import type { SupabaseHookConfig } from "../types.ts";

import { configError } from "../core/errors.ts";

/** `supabase.hook.refresh`: how the hook answers a token refresh. */
export type RefreshMode = NonNullable<SupabaseHookConfig["refresh"]>;

/** `supabase.hook.oauth`: the claim shape of a token issued to an OAuth client. */
export type OauthMode = NonNullable<SupabaseHookConfig["oauth"]>;

/**
 * Why the refresh fast path cannot run for these sources, or `undefined` when
 * every change to what the memberships claim reads bumps `authz_ver`.
 *
 * A membership table, a roles table, the teams table and the tables a role or a
 * user id is read through all carry a version trigger. Two things change a
 * claim without a write to those tables: a row expiring (`expiresAt`) and a
 * suspended scope read from another table (`reads`). The fast path never runs
 * for a source with either, nor with a suspended-tenant table, which
 * `memberships_for` reads for every source. The suspended-user table is the one
 * read the hook checks itself, before it looks at the token.
 */
function refreshBlocker(
  sources: readonly SqlMembershipSource[],
  version: boolean,
  usersTable: string | undefined,
  tenantsTable: string | undefined,
): string | undefined {
  if (!version) {
    return "supabase.hook.version is false, so the token carries no authz_ver to compare";
  }
  if (tenantsTable !== undefined) {
    return `the tenants are suspended through ${tenantsTable} (rls.suspension.scopes): a change there does not bump authz_ver`;
  }
  for (const source of sources) {
    if (source.sql.manifest.expiresAt !== undefined) {
      return `the ${source.sql.table} source has expiresAt: a row expires without a write, so authz_ver does not move`;
    }
    const reads = source.sql.reads.filter((table) => table !== usersTable);
    if (reads.length > 0) {
      return `the ${source.sql.table} source reads ${reads.join(", ")} (scope suspension): a change there does not bump authz_ver`;
    }
  }
  return undefined;
}

function refreshMode(hook: SupabaseHookConfig): RefreshMode {
  const mode = hook.refresh ?? "reuse";
  if (mode !== "reuse" && mode !== "full") {
    throw configError(
      `PermDock CLI: supabase.hook.refresh must be 'reuse' or 'full' (got ${String(mode)})`,
    );
  }
  return mode;
}

/**
 * `supabase.hook.membershipsClaim`. `false` needs `database` mode, where the
 * helpers read memberships from the tables, and rules out an explicit `refresh:
 * 'reuse'`: a refresh has no entries to reuse.
 */
export function membershipsClaim(
  hook: SupabaseHookConfig,
  authorize: "database" | "jwt",
): boolean {
  const value: unknown = hook.membershipsClaim ?? true;
  if (typeof value !== "boolean") {
    throw configError(
      `PermDock CLI: supabase.hook.membershipsClaim must be a boolean (got ${String(value)})`,
    );
  }
  if (!value && authorize !== "database") {
    throw configError(
      "PermDock CLI: supabase.hook.membershipsClaim: false needs rls.authorize: 'database'; in 'jwt' mode the RLS helpers read memberships from the claim",
    );
  }
  if (!value && hook.refresh === "reuse") {
    throw configError(
      "PermDock CLI: supabase.hook.refresh 'reuse' cannot run: supabase.hook.membershipsClaim is false, so a refresh has no memberships to reuse",
    );
  }
  return value;
}

export function oauthMode(hook: SupabaseHookConfig): OauthMode {
  const mode = hook.oauth ?? "full";
  if (mode !== "full" && mode !== "slim") {
    throw configError(
      `PermDock CLI: supabase.hook.oauth must be 'full' or 'slim' (got ${String(mode)})`,
    );
  }
  return mode;
}

/**
 * Whether the hook compiles the fast path. An explicit `refresh: 'reuse'` that
 * cannot hold fails the command; the default falls back to the full path.
 */
export function refreshReuse(
  hook: SupabaseHookConfig,
  sources: readonly SqlMembershipSource[],
  version: boolean,
  usersTable: string | undefined,
  tenantsTable?: string,
): boolean {
  const mode = refreshMode(hook);
  if (mode === "full") {
    return false;
  }
  const blocker = refreshBlocker(sources, version, usersTable, tenantsTable);
  if (blocker !== undefined && hook.refresh === "reuse") {
    throw configError(
      `PermDock CLI: supabase.hook.refresh 'reuse' cannot run: ${blocker}`,
    );
  }
  return blocker === undefined;
}
