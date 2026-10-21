import type { Policy } from "../../core/policy-types.ts";
import type {
  SupabaseDatabaseManifest,
  SupabaseHookManifest,
  SupabaseManifestActiveRow,
  SupabaseManifestHelper,
  SupabaseManifestRequires,
  SupabaseManifestRls,
} from "../../supabase/manifest.ts";
import type { RlsSqlContext } from "../sql/context.ts";
import type {
  PermDockConfig,
  RlsActiveRow,
  RlsSuspendedScope,
} from "../types.ts";
import type { Parts } from "./parts.ts";

import { hasConditionOp } from "../../conditions/ast.ts";
import { qualifySqlTable } from "../../core/sql.ts";
import { keptKeys } from "../../supabase/keep.ts";
import { SUPABASE_MANIFEST_SCHEMA } from "../core/version.ts";
import { API_KEY_ALLOWS, apiKeyFields } from "../rls/api-keys.ts";
import { IS_APPROVER } from "../rls/approvals.ts";
import { guardedTables } from "../rls/assignments.ts";
import { ASSIGNMENTS, OWNERSHIP } from "../rls/ownership-names.ts";
import { ownershipRules } from "../rls/ownership.ts";
import { permittedUsersHelper } from "../rls/permission-holders.ts";
import { permissionKeysForHelper } from "../rls/permission-keys.ts";
import { ACTOR_MAY_WRITE, readOnlyActorKinds } from "../rls/policies.ts";
import { resolveAuthorize } from "../rls/rbac.ts";
import { TOKEN_SCOPE_ALLOWS } from "../rls/token-scopes.ts";
import { checkSuspension } from "../sql/active.ts";
import { scopeTypeOf, tenantTypeOf } from "../sql/columns.ts";
import { decidingColumns } from "../sql/deciding-columns.ts";
import { HOOK_MARKER } from "../sql/markers.ts";
import {
  isTeamScope,
  memberForHelper,
  memberIdsHelper,
  memberOfHelper,
  permittedForHelper,
  permittedIdsHelper,
} from "../sql/names.ts";
import { customRolesOn, HELPERS } from "../sql/shared.ts";
import { USER_ID_HELPER } from "../sql/subject.ts";
import { hookClaims } from "./claims.ts";
import { BUDGET_MEASURE } from "./sql.ts";
import { AUTHZ_VERSION_BUMP } from "./version.ts";

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
        ...(parts.helpers.memberFor.includes(scope.name) &&
        isTeamScope(scope.name)
          ? [
              helperEntry(
                memberOfHelper(scope.name),
                "p_user uuid",
                returns,
                client,
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
 * The helpers `rls generate` writes beyond the ones the hook's claims feed: the
 * `_for` forms in `database` mode, and the assignment checks when a role
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
  const custom = database && customRolesOn(config.rls);
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
        ...scopeTypes
          .filter(([scope]) => parts.helpers.holders.includes(scope))
          .map(([scope, type]) =>
            helperEntry(
              permittedUsersHelper(scope),
              `p_permission text, p_id ${type}`,
              "setof uuid",
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
    ...(config.rls?.tokenScopes === true
      ? [helperEntry(TOKEN_SCOPE_ALLOWS, "p_grant text", "boolean", client)]
      : []),
    ...(readOnlyActorKinds(config.rls?.readOnlyActors) === undefined
      ? []
      : [helperEntry(ACTOR_MAY_WRITE, "", "boolean", client)]),
    ...(config.rls?.approvals === true ||
    typeof config.rls?.approvals === "object"
      ? [
          helperEntry(
            IS_APPROVER,
            typeof config.rls.approvals === "object" &&
              config.rls.approvals.delegations === true
              ? "p_approvers jsonb, p_tenant text, p_requester text, p_resource text"
              : "p_approvers jsonb, p_tenant text",
            "boolean",
            client,
          ),
        ]
      : []),
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
    table: qualifySqlTable(row.table),
    id: row.id,
    ...(row.disabledAt === undefined ? {} : { disabledAt: row.disabledAt }),
    ...(row.status === undefined ? {} : { status: row.status }),
    ...(row.active === undefined ? {} : { active: row.active }),
    ...(keep.length === 0 ? {} : { keep }),
  };
}

/**
 * The `rls` settings a package writing SQL next to the helpers reads: custom
 * roles, global roles, suspension and assignment triggers.
 */
function rlsSettings(
  parts: Parts,
  config: PermDockConfig,
): Pick<
  SupabaseManifestRls,
  | "customRoles"
  | "roles"
  | "suspension"
  | "assignments"
  | "apiKeys"
  | "tokenScopes"
> {
  const rls = config.rls;
  const suspension = checkSuspension(rls?.suspension, parts.scopes);
  const scopes = Object.entries(suspension?.scopes ?? {});
  const assigned =
    rls?.assignments === undefined
      ? undefined
      : guardedTables(config, parts.scopes);
  return {
    customRoles: resolveAuthorize(config) === "database" && customRolesOn(rls),
    ...(parts.roles === undefined
      ? {}
      : {
          roles: {
            table: qualifySqlTable(parts.roles.table),
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
              : { memberships: { keep: keptKeys(suspension.memberships) } }),
          },
        }),
    ...(assigned === undefined ? {} : { assignments: { tables: assigned } }),
    ...(rls?.apiKeys === undefined
      ? {}
      : { apiKeys: apiKeyFields(rls.apiKeys) }),
    ...(rls?.tokenScopes === true ? { tokenScopes: true } : {}),
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
      parts.hook.teams,
    ),
    markers: { hook: "v1", grants: "v1" },
    requires: requiredCapabilities(config, policy),
  };
}

/**
 * The manifest without the token hook: what a project with no `supabase.hook`
 * records.
 */
export function databaseManifestOf(
  parts: Parts,
  out: string,
  config: PermDockConfig,
  policy?: Policy,
): SupabaseDatabaseManifest {
  const {
    hook: _hook,
    budget: _budget,
    claims: _claims,
    authzVersion: _authzVersion,
    authzVersionBump: _authzVersionBump,
    memberships: _memberships,
    ...rest
  } = manifestOf(parts, out, config, policy);
  return rest;
}

/**
 * The first line of the generated hook: fields `--check` compares before the
 * full text.
 */
export function hookMarker(manifest: SupabaseHookManifest): string {
  return `${HOOK_MARKER} schema=${manifest.hook.schema} tenant=${manifest.tenantClaim} budget=${String(manifest.budget.bytes)} claims=${manifest.claims.map((claim) => claim.name).join(",")}`;
}

export function defaultOut(config: PermDockConfig): string {
  return config.supabase?.hook?.out ?? "supabase/permdock-hook.sql";
}
