import type { Policy } from "../core/policy.ts";
import type {
  SupabaseHookManifest,
  SupabaseManifestActiveRow,
  SupabaseManifestHelper,
  SupabaseManifestRequires,
  SupabaseManifestRls,
} from "../supabase/manifest.ts";
import type { RlsSqlContext } from "./rls-sql.ts";
import type { Parts } from "./supabase-hook-sql.ts";
import type {
  PermDockConfig,
  RlsActiveRow,
  RlsSuspendedScope,
} from "./types.ts";

import { hasConditionOp } from "../conditions/ast.ts";
import { keptKeys } from "../supabase/keep.ts";
import { decidingColumns } from "./deciding-columns.ts";
import { HOOK_MARKER } from "./markers.ts";
import { API_KEY_ALLOWS, apiKeyFields } from "./rls-api-keys.ts";
import {
  ASSIGNMENTS,
  guardedTables,
  OWNERSHIP,
  ownershipRules,
} from "./rls-ownership.ts";
import { permissionKeysForHelper } from "./rls-permission-keys.ts";
import { resolveAuthorize } from "./rls-rbac.ts";
import { HELPERS } from "./rls-shared.ts";
import {
  checkSuspension,
  memberForHelper,
  memberIdsHelper,
  permittedForHelper,
  permittedIdsHelper,
  qualifiedTable,
  scopeTypeOf,
  tenantTypeOf,
  USER_ID_HELPER,
} from "./rls-sql.ts";
import {
  AUTHZ_VERSION_BUMP,
  BUDGET_MEASURE,
  hookClaims,
} from "./supabase-hook-sql.ts";
import { SUPABASE_MANIFEST_SCHEMA } from "./version.ts";

function helperList(
  parts: Parts,
  types: ReadonlyMap<string, string>,
): readonly SupabaseManifestHelper[] {
  const client = ["authenticated"];
  return [
    helperEntry(HELPERS.has, "p_grant text", "boolean", client),
    ...parts.scopes.flatMap((scope): SupabaseManifestHelper[] => {
      const returns = `setof ${types.get(scope.name) ?? "uuid"}`;
      return [
        helperEntry(
          permittedIdsHelper(scope.name),
          "p_grant text",
          returns,
          client,
        ),
        helperEntry(memberIdsHelper(scope.name), "", returns, client),
        ...(parts.helpers.memberFor.includes(scope.name)
          ? [
              helperEntry(
                memberForHelper(scope.name),
                "p_user uuid",
                returns,
                parts.extra.length === 0 ? [] : ["supabase_auth_admin"],
              ),
            ]
          : []),
      ];
    }),
  ];
}

function helperEntry(
  name: string,
  args: string,
  returns: string,
  execute: readonly string[],
): SupabaseManifestHelper {
  return { name, args, returns, execute };
}

/**
 * The helpers `rls generate` writes beyond the ones the hook's claims feed:
 * the `_for` forms in `database` mode, and the assignment checks when a role
 * declares `assigns` (known only with the policy).
 */
function trustedHelpers(
  parts: Parts,
  config: PermDockConfig,
  types: ReadonlyMap<string, string>,
  tenantType: string,
  policy: Policy | undefined,
): readonly SupabaseManifestHelper[] {
  const database = resolveAuthorize(config) === "database";
  const custom = database && config.rls?.customRoles === true;
  const everyFor = parts.scopes.every((scope) =>
    parts.helpers.memberFor.includes(scope.name),
  );
  const client = ["authenticated"];
  const scopeTypes = parts.scopes.map(
    (scope) => [scope.name, types.get(scope.name) ?? "uuid"] as const,
  );
  const forUser = database
    ? [
        helperEntry(HELPERS.hasFor, "p_user uuid, p_grant text", "boolean", []),
        ...scopeTypes.map(([scope, type]) =>
          helperEntry(
            permittedForHelper(scope),
            "p_user uuid, p_grant text",
            `setof ${type}`,
            [],
          ),
        ),
        ...scopeTypes.map(([scope, type]) =>
          helperEntry(
            permissionKeysForHelper(scope),
            `p_user uuid, p_id ${type}`,
            "setof text",
            [],
          ),
        ),
      ]
    : [];
  const keyed = [
    helperEntry(USER_ID_HELPER, "", "uuid", client),
    ...(config.rls?.apiKeys === undefined
      ? []
      : [helperEntry(API_KEY_ALLOWS, "p_grant text", "boolean", client)]),
    ...forUser,
  ];
  const assigns =
    policy !== undefined &&
    (ownershipRules(policy, parts.scopes)?.assigns.length ?? 0) > 0;
  if (!assigns) {
    return keyed;
  }
  const customArgs = `p_tenant ${tenantType}, p_scope text, p_scope_id text, p_role text`;
  const anyArgs = `p_role text, p_tenant ${tenantType}, p_scope text, p_scope_id text`;
  return [
    ...keyed,
    helperEntry(
      OWNERSHIP.canAssign,
      "p_role text, p_scope_id text",
      "boolean",
      client,
    ),
    ...(database
      ? [
          helperEntry(
            OWNERSHIP.canAssignFor,
            "p_user uuid, p_role text, p_scope_id text",
            "boolean",
            [],
          ),
        ]
      : []),
    ...(custom
      ? [helperEntry(ASSIGNMENTS.custom, customArgs, "boolean", client)]
      : []),
    ...(custom && everyFor
      ? [
          helperEntry(
            ASSIGNMENTS.customFor,
            `p_user uuid, ${customArgs}`,
            "boolean",
            [],
          ),
        ]
      : []),
    helperEntry(OWNERSHIP.canAssignAny, anyArgs, "boolean", client),
    ...(database && (!custom || everyFor)
      ? [
          helperEntry(
            OWNERSHIP.canAssignAnyFor,
            `p_user uuid, ${anyArgs}`,
            "boolean",
            [],
          ),
        ]
      : []),
  ];
}

function activeRowManifest(
  row: RlsActiveRow | RlsSuspendedScope,
): SupabaseManifestActiveRow {
  const keep = "keep" in row ? keptKeys(row) : [];
  return {
    table: qualifiedTable(row.table),
    id: row.id,
    ...(row.disabledAt === undefined ? {} : { disabledAt: row.disabledAt }),
    ...(row.status === undefined ? {} : { status: row.status }),
    ...(row.active === undefined ? {} : { active: row.active }),
    ...(keep.length === 0 ? {} : { keep }),
  };
}

/** The `rls` settings a package writing SQL next to the helpers reads: custom roles, global roles, suspension and assignment triggers. */
function rlsSettings(
  parts: Parts,
  config: PermDockConfig,
): Pick<
  SupabaseManifestRls,
  "customRoles" | "roles" | "suspension" | "assignments" | "apiKeys"
> {
  const rls = config.rls;
  const suspension = checkSuspension(rls?.suspension, parts.scopes);
  const scopes = Object.entries(suspension?.scopes ?? {});
  const assigned =
    rls?.assignments === undefined
      ? undefined
      : guardedTables(config, parts.scopes);
  return {
    customRoles:
      resolveAuthorize(config) === "database" && rls?.customRoles === true,
    ...(parts.roles === undefined
      ? {}
      : {
          roles: {
            table: qualifiedTable(parts.roles.table),
            user: { column: parts.roles.user },
            role: parts.roles.role,
          },
        }),
    ...(suspension === undefined
      ? {}
      : {
          suspension: {
            ...(suspension.users === undefined
              ? {}
              : { users: activeRowManifest(suspension.users) }),
            ...(scopes.length === 0
              ? {}
              : {
                  scopes: Object.fromEntries(
                    scopes.map(([name, row]) => [name, activeRowManifest(row)]),
                  ),
                }),
            ...(suspension.memberships === undefined
              ? {}
              : {
                  memberships: { keep: keptKeys(suspension.memberships) },
                }),
          },
        }),
    ...(assigned === undefined ? {} : { assignments: { tables: assigned } }),
    ...(rls?.apiKeys === undefined
      ? {}
      : { apiKeys: apiKeyFields(rls.apiKeys) }),
  };
}

/** The `supabase/sdk` release `requires.capabilities` names features of. */
const CAPABILITY_MATRIX = "capability-matrix-v1.12.0";

function usesLiveSession(policy: Policy | undefined): boolean {
  return [
    ...(policy?.grants ?? []),
    ...(policy?.roles.flatMap((binding) => binding.grants) ?? []),
  ].some(
    (grant) =>
      hasConditionOp(grant.where, "liveSession") ||
      hasConditionOp(grant.check, "liveSession"),
  );
}

function requiredCapabilities(
  config: PermDockConfig,
  policy: Policy | undefined,
): SupabaseManifestRequires {
  const ids = new Set(["auth.session.get_claims"]);
  if (usesLiveSession(policy)) {
    ids.add("auth.session.get_user");
  }
  if (config.rls?.realtime !== undefined) {
    ids.add("realtime.subscriptions.private_channel");
  }
  for (const bucket of Object.values(config.rls?.storage?.buckets ?? {})) {
    if (bucket.read !== undefined) {
      ids.add("storage.file_buckets.download");
      ids.add("storage.file_buckets.list_files");
    }
    if (bucket.write !== undefined) {
      ids.add("storage.file_buckets.upload");
      ids.add("storage.file_buckets.update_file");
      ids.add("storage.file_buckets.move");
    }
    if (bucket.delete !== undefined) {
      ids.add("storage.file_buckets.remove");
    }
  }
  return { matrix: CAPABILITY_MATRIX, capabilities: [...ids].toSorted() };
}

export function manifestOf(
  parts: Parts,
  out: string,
  config: PermDockConfig,
  policy?: Policy,
): SupabaseHookManifest {
  const rls = config.rls;
  const ctx: RlsSqlContext = {
    dialect: "supabase",
    scopes: parts.scopes,
    tenantClaim: parts.tenantClaim,
    gucPrefix: rls?.gucPrefix ?? "app",
    tenantType: rls?.tenantType ?? "uuid",
    ...(rls?.teamType === undefined ? {} : { teamType: rls.teamType }),
    ...(rls?.scopeTypes === undefined ? {} : { scopeTypes: rls.scopeTypes }),
  };
  const types = new Map(
    parts.scopes.map((scope) => [scope.name, scopeTypeOf(ctx, scope.name)]),
  );
  const helpers = helperList(parts, types);
  return {
    $schema: SUPABASE_MANIFEST_SCHEMA,
    version: 1,
    hook: {
      schema: parts.schema,
      function: "custom_access_token_hook",
      out,
      ...(parts.before.length === 0 ? {} : { before: parts.before }),
    },
    helpers: {
      schema: parts.helpers.schema,
      functions: helpers.map((entry) => entry.name),
    },
    tenantClaim: parts.tenantClaim,
    budget: { bytes: parts.budget, measure: BUDGET_MEASURE },
    claims: hookClaims(parts),
    authzVersion: parts.version,
    ...(parts.version
      ? {
          authzVersionBump: {
            schema: parts.schema,
            function: AUTHZ_VERSION_BUMP,
            args: "p_users uuid[]",
          },
        }
      : {}),
    memberships: parts.sources.map((source) => source.sql.manifest),
    rls: {
      schema: parts.helpers.schema,
      mode: resolveAuthorize(config),
      tenantClaim: parts.tenantClaim,
      scopes: parts.scopes.map((scope) => ({
        name: scope.name,
        type: types.get(scope.name) ?? "uuid",
        ...(scope.within === undefined ? {} : { within: scope.within }),
      })),
      helpers: [
        ...helpers,
        ...trustedHelpers(parts, config, types, tenantTypeOf(ctx), policy),
      ],
      memberships: parts.helpers.memberships,
      ...rlsSettings(parts, config),
    },
    decidingColumns: decidingColumns(
      config,
      parts.attrs === undefined
        ? undefined
        : {
            ...(parts.attrs.table === undefined
              ? {}
              : { table: parts.attrs.table }),
            columns: parts.attrs.columns,
          },
    ),
    markers: { hook: "v1", grants: "v1" },
    requires: requiredCapabilities(config, policy),
  };
}

/** The first line of the generated hook: fields `--check` compares before the full text. */
export function hookMarker(manifest: SupabaseHookManifest): string {
  return `${HOOK_MARKER} schema=${manifest.hook.schema} tenant=${manifest.tenantClaim} budget=${String(manifest.budget.bytes)} claims=${manifest.claims.map((claim) => claim.name).join(",")}`;
}

export function defaultOut(config: PermDockConfig): string {
  return config.supabase?.hook?.out ?? "supabase/permdock-hook.sql";
}
