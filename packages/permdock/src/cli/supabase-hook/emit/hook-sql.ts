import type { Policy } from "../../../core/policy-types.ts";
import type { Scope } from "../../../core/scopes.ts";
import type {
  SupabaseDatabaseManifest,
  SupabaseHookManifest,
} from "../../../supabase/manifest.ts";
import type { PermDockConfig, SupabaseSchemas } from "../../types.ts";
import type { HookOverrides } from "../sql.ts";

import { STDOUT } from "../../core/output-files.ts";
import { GRANTS_MARKER } from "../../sql/markers.ts";
import { membershipSourcesOf } from "../../sql/sources.ts";
import { splitUndiffed } from "../../sql/statements.ts";
import {
  apiWrappersSql,
  authzVersionForSql,
  membersOfSql,
  permdockSubjectSql,
  subjectForSql,
} from "../api.ts";
import { attrsGuardSql } from "../claims.ts";
import { globalRolesSql, membershipEntriesSql } from "../entries.ts";
import {
  databaseManifestOf,
  defaultOut,
  hookMarker,
  manifestOf,
} from "../manifest.ts";
import {
  configToml,
  grantsSql,
  hookParts,
  hookSql,
  managedSql,
  schemaSql,
} from "../sql.ts";
import { versionSql } from "../version.ts";

/**
 * The manifest `supabase inspect` prints. With `policy`, `rls.helpers` also
 * lists the assignment checks `rls generate` writes for roles that declare
 * `assigns`.
 */
export function supabaseHookManifest(
  scopes: readonly Scope[],
  config: PermDockConfig,
  overrides: HookOverrides & {
    readonly out?: string;
    readonly schemas?: SupabaseSchemas;
  } = {},
  policy?: Policy,
): SupabaseHookManifest {
  const parts = hookParts(scopes, config, overrides);
  const manifest = manifestOf(
    parts,
    overrides.out ?? defaultOut(config),
    config,
    policy,
  );
  return overrides.schemas === undefined
    ? manifest
    : { ...manifest, hook: { ...manifest.hook, schemas: overrides.schemas } };
}

/**
 * The manifest of a project in `rls.authorize: 'database'` mode with no
 * `supabase.hook`: the helpers, scopes, membership sources and grants, and no
 * token hook.
 */
export function supabaseDatabaseManifest(
  scopes: readonly Scope[],
  config: PermDockConfig,
  overrides: HookOverrides & { readonly out?: string } = {},
  policy?: Policy,
): SupabaseDatabaseManifest {
  const parts = hookParts(
    scopes,
    {
      ...config,
      supabase: {
        ...config.supabase,
        hook: { memberships: membershipSourcesOf(config) },
      },
    },
    overrides,
  );
  return databaseManifestOf(
    parts,
    overrides.out ?? defaultOut(config),
    config,
    policy,
  );
}

/**
 * The hook migration. With `grantsOut`, the statements `supabase db diff` drops
 * are left out of `sql` and returned in `grants` for that file.
 */
export function supabaseHookSql(
  scopes: readonly Scope[],
  config: PermDockConfig,
  overrides: HookOverrides = {},
  grantsOut?: string,
): {
  readonly sql: string;
  readonly grants: string;
  readonly manifest: SupabaseHookManifest;
} {
  const parts = hookParts(scopes, config, overrides);
  const manifest = manifestOf(parts, defaultOut(config), config);
  const toml = configToml(parts.schema, parts.jwtExpiry)
    .split("\n")
    .map((line) => (line === "" ? "--" : `--   ${line}`))
    .join("\n");
  const sql = [
    `${hookMarker(manifest)}
-- custom_access_token_hook(jsonb): memberships go active ${parts.root} first and stop at the budget
-- supabase/config.toml:
${toml}${grantsOut === undefined ? "" : `\n-- what supabase db diff drops from this part is in ${grantsOut}`}`,
    schemaSql(parts),
    attrsGuardSql(parts.attrs, parts.schema),
    globalRolesSql(parts),
    membershipEntriesSql(parts),
    hookSql(parts),
    versionSql(parts),
    subjectForSql(parts, config),
    permdockSubjectSql(parts),
    authzVersionForSql(parts),
    membersOfSql(parts),
    apiWrappersSql(parts),
    grantsSql(parts),
    managedSql(parts),
  ]
    .filter((chunk) => chunk !== "")
    .join("\n\n");
  const { kept, moved } = splitUndiffed(`${sql}\n`);
  const grants = `${GRANTS_MARKER} schema=${parts.schema}
-- the privileges and view options supabase db diff drops from the hook part
${moved.join("\n")}
`;
  return { sql: grantsOut === undefined ? `${sql}\n` : kept, grants, manifest };
}

/** What the hook file's header says about where its grants went. */
export function grantsLabel(grantsOut: string | undefined): string | undefined {
  if (grantsOut === undefined) {
    return undefined;
  }
  return grantsOut === STDOUT ? "a separate migration" : grantsOut;
}
