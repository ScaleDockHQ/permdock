import type {
  AuthorizationMembership,
  AuthorizationOperation,
  AuthorizationPermission,
  AuthorizationProvider,
  AuthorizationRoleSource,
} from "better-supabase/contract";

import type { CatalogDocument } from "../catalog/types.ts";
import type { OperationRisk } from "../core/operation-risks.ts";
import type { OperationEffect } from "../core/operations.ts";
import type { Permission } from "../core/permission-types.ts";
import type { PermissionKeyOf } from "../core/type-helpers.ts";
import type {
  SupabaseManifest,
  SupabaseManifestActiveRow,
  SupabaseManifestMembership,
  SupabaseManifestRole,
} from "../supabase/manifest.ts";
import type { BetterSupabaseActiveTenant } from "./active-tenant.ts";
import type { ProviderApprovers } from "./approvers.ts";

import { parseCatalog } from "../catalog/parse.ts";
import { freezeDeep } from "../core/freeze.ts";
import { delegatedScopeMap } from "../core/oauth-scopes.ts";
import { quoteSqlLiteral, sqlIdent } from "../core/sql.ts";
import { hasTokenHook, parseSupabaseManifest } from "../supabase/manifest.ts";
import { activeTenantMismatch } from "./active-tenant.ts";
import { ASSIGN_ANY, providerFunctions } from "./provider-functions.ts";
import { tokenHookOf } from "./provider-hook.ts";
import { fixtureRolesOf } from "./provider-personas.ts";

type ProviderKey<P> = [P] extends [undefined]
  ? string
  : PermissionKeyOf<Exclude<P, undefined>>;

export type AuthorizationProviderOptions<P = undefined> = {
  /**
   * `permdock.manifest.json`, parsed or as JSON text, from `permdock supabase
   * inspect --out`.
   */
  readonly manifest: unknown;
  /**
   * `permissions.catalog.json` from `permdock catalog`. Without it the provider
   * lists no permissions, so better-supabase refuses every key in a bucket,
   * topic or module check.
   */
  readonly catalog?: unknown;
  /** The scope tenants are; defaults to the manifest's one root scope. */
  readonly scope?: string;
  /**
   * The permission that lets a user decide a tool call waiting for approval:
   * the `'ai-tool'` entry of `approvers` (`holder(approver)`) unless
   * `approvers` names one. The requester is never their own approver.
   */
  readonly approver?: Permission;
  /**
   * Who may approve each request kind, for better-supabase's `isApprover`:
   * `'ai-tool'`, `'support-session'` or the approvals block's `'<subject
   * type>.<action>'`, each mapped to `user()`, `holder()` or `anyOf()`
   * approvers. A kind it does not name has no provider approver, which for tool
   * calls and support sessions means nobody but the service role. Needs
   * `permdock_is_approver` from `rls.approvals`.
   */
  readonly approvers?: ProviderApprovers;
  readonly requestApprovers?: boolean;
  /**
   * better-supabase's `blocks.permissions.activeTenant`. When the token hook
   * reads the active tenant from another place than better-supabase writes it,
   * `problems` names the `supabase.hook.activeFrom` to set. With `"resolver"`
   * the tenant comes from the request, so `tokenHook.activeOrganizationFrom`
   * stays unset and doctor BS409 has nothing to compare.
   */
  readonly activeTenant?: BetterSupabaseActiveTenant;
  /**
   * Fill better-supabase's `rowsWith` (and `rowsWithFor` when the `_for`
   * helpers exist) from the `rls.rowHelpers` helpers the manifest names, so a
   * `config.recordTypes.<type>.permissions.<action>` entry with `rows` checks
   * the rows the caller holds a permission on.
   */
  readonly rowHelpers?: boolean;
  /**
   * Users better-supabase's access matrix signs in as, one pgTAP file each
   * (`providerPersonaTests`). `setup` creates the memberships and roles with
   * `{user}` and `{tenant}`; `permissions` are the keys the persona holds in
   * the tenant, and every other `sqlComplete` key is asserted denied. `'roles'`
   * is sent as written, with one `fixtureRoles` entry per role the manifest's
   * `fixtureRoles` names (the `defineSeeds` fixtures), or per catalog role at
   * the tenant scope and global role without it. An array is the personas as
   * written.
   */
  readonly personas?: "roles" | readonly ProviderPersona[];
  /**
   * Names `permdock_subject()` as `functions.subject` and
   * `permdock_subject(p_tenant)` as `functions.subjectForTenant`. Default on
   * when the manifest lists the helper. `false` leaves both out.
   */
  readonly subject?: boolean;
  /**
   * Fills `platformRoles` from `rls.roles`. Default on when that table is a
   * column. `false` leaves it out.
   */
  readonly platformRoles?: boolean;
  /**
   * The permission tree the catalog was generated from. It types the provider's
   * keys; the catalog still supplies the entries.
   */
  readonly permissions?: P;
};

/** One `personas` entry of better-supabase's `AuthorizationProvider`. */
export type ProviderPersona = {
  readonly name: string;
  readonly setup: string;
  readonly claims?: Readonly<Record<string, unknown>>;
  readonly permissions: readonly string[];
};

type DisabledRow = NonNullable<
  NonNullable<AuthorizationProvider["suspension"]>["user"]
>;

/**
 * Postgres aliases of the id types better-supabase reads (`uuid`, `text`,
 * `bigint`, `integer`), matching its `moduleIdType` from `better-supabase/sql`,
 * which this runtime entry does not import.
 */
const ID_TYPES: Readonly<Record<string, string>> = {
  uuid: "uuid",
  text: "text",
  varchar: "text",
  "character varying": "text",
  bigint: "bigint",
  int8: "bigint",
  integer: "integer",
  int: "integer",
  int4: "integer",
};

function tenantScopeOf(
  manifest: SupabaseManifest,
  explicit: string | undefined,
): string {
  const names = manifest.rls.scopes.map((scope) => scope.name);
  if (explicit !== undefined) {
    if (!names.includes(explicit)) {
      throw new TypeError(
        `PermDock: scope "${explicit}" is not in the manifest's rls.scopes (${names.join(", ")}).`,
      );
    }
    return explicit;
  }
  const roots = manifest.rls.scopes.filter(
    (scope) => scope.within === undefined,
  );
  const [root] = roots;
  if (root === undefined || roots.length > 1) {
    const listed = roots.map((scope) => scope.name).join(", ");
    throw new TypeError(
      `PermDock: the manifest has ${roots.length} root scopes (${listed === "" ? "none" : listed}), so it can't tell which scope tenants are. Pass { scope } with one of ${names.join(", ")}.`,
    );
  }
  return root.name;
}

function covers(
  membership: SupabaseManifestMembership,
  scope: string,
): boolean {
  return !("value" in membership.scope) || membership.scope.value === scope;
}

/** `source` as better-supabase reads it, for a source that covers `scope`. */
function membershipOf(
  source: SupabaseManifestMembership,
  scope: string,
  problems: string[],
): AuthorizationMembership | undefined {
  if ("through" in source.user) {
    problems.push(
      `${source.table} reads its user id through ${source.user.through.table}, which better-supabase's membership reads don't follow.`,
    );
    return undefined;
  }
  return {
    table: source.table,
    userColumn: source.user.column,
    scope:
      "column" in source.scope
        ? { column: source.scope.column }
        : { value: scope },
    idColumn: source.id.column,
    ...(source.disabledAt === undefined
      ? {}
      : { disabledAt: source.disabledAt.column }),
    ...rolesTableOf(source),
  };
}

/**
 * The role set a member's roles come from, one row per scope id, user and role:
 * a role read through a reference over several columns.
 */
function rolesTableOf(source: SupabaseManifestMembership): {
  readonly rolesTable?: string;
} {
  const roles: readonly SupabaseManifestRole[] = isRoleList(source.role)
    ? source.role
    : [source.role];
  for (const role of roles) {
    if ("through" in role && role.through.on !== undefined) {
      return { rolesTable: role.through.table };
    }
  }
  return {};
}

function isRoleList(
  role: SupabaseManifestMembership["role"],
): role is readonly SupabaseManifestRole[] {
  return Array.isArray(role);
}

function scopeValue(source: SupabaseManifestMembership): string | undefined {
  if (!("value" in source.scope)) {
    return undefined;
  }
  return typeof source.scope.value === "string"
    ? source.scope.value
    : undefined;
}

function scopeRoleKeys(
  catalog: CatalogDocument | undefined,
  scope: string | undefined,
): readonly string[] {
  return (catalog?.roles ?? [])
    .filter((role) =>
      scope === undefined ? typeof role.on === "string" : role.on === scope,
    )
    .map((role) => role.key)
    .toSorted();
}

function roleWhere(
  column: string,
  keys: readonly string[],
  tenant: string | undefined,
): string | undefined {
  const parts: string[] = [];
  if (keys.length > 0) {
    const listed = keys.map((key) => quoteSqlLiteral(key)).join(", ");
    parts.push(`{row}.${sqlIdent(column)} in (${listed})`);
  }
  if (tenant !== undefined && tenant !== "") {
    parts.push(`{row}.${sqlIdent(tenant)} is not null`);
  }
  return parts.length === 0 ? undefined : parts.join(" or ");
}

function roleSourceOf(
  source: SupabaseManifestMembership,
  catalog: CatalogDocument | undefined,
  tenant: string | undefined,
): AuthorizationRoleSource | undefined {
  const role = source.role;
  if (
    Array.isArray(role) ||
    !("column" in role) ||
    !("through" in role) ||
    role.through.on !== undefined
  ) {
    return undefined;
  }
  const where = roleWhere(
    role.through.column,
    scopeRoleKeys(catalog, scopeValue(source)),
    tenant,
  );
  return {
    table: source.table,
    role: {
      column: role.column,
      through: {
        table: role.through.table,
        id: role.through.id,
        column: role.through.column,
        ...(where === undefined ? {} : { where }),
      },
    },
  };
}

function disabledRow(row: SupabaseManifestActiveRow): DisabledRow {
  return {
    table: row.table,
    id: row.id,
    ...(row.disabledAt === undefined ? {} : { disabledAt: row.disabledAt }),
    ...(row.status === undefined || row.active === undefined
      ? {}
      : { status: row.status, active: row.active }),
  };
}

/**
 * `rls.roles` as better-supabase's `platformRoles`: the global-roles table with
 * its roles table, and the assignment helpers that answer without a tenant.
 */
function platformRolesOf(
  manifest: SupabaseManifest,
  schema: string,
  scope: string,
  assignAny: boolean,
): AuthorizationProvider["platformRoles"] {
  const roles = manifest.rls.roles;

  if (
    roles === undefined ||
    isRoleList(roles.role) ||
    !("column" in roles.role)
  ) {
    return undefined;
  }

  const through = "through" in roles.role ? roles.role.through : undefined;
  const literal = quoteSqlLiteral(scope);

  return {
    table: roles.table,
    user: roles.user.column,
    role: roles.role.column,
    ...(through === undefined || through.on !== undefined
      ? {}
      : {
          through: {
            table: through.table,
            id: through.id,
            column: through.column,
          },
        }),
    ...(assignAny
      ? {
          canAssign: `${schema}.${ASSIGN_ANY.canAssign.helper}({role}, null::uuid, ${literal}, null::text)`,
          canAssignFor: `${schema}.${ASSIGN_ANY.canAssignFor.helper}({user}, {role}, null::uuid, ${literal}, null::text)`,
        }
      : {}),
  };
}

function permissionsOf(
  catalog: CatalogDocument,
  scopes: ReadonlySet<string>,
): AuthorizationPermission[] {
  return catalog.permissions.map((permission) => {
    const granted = new Set<string>();
    for (const grant of catalog.grants ?? []) {
      if (
        grant.permission === permission.key &&
        typeof grant.scope === "string" &&
        scopes.has(grant.scope)
      ) {
        granted.add(grant.scope);
      }
    }
    return {
      key: permission.key,
      sqlComplete: !permission.rowConditions,
      ...(granted.size > 0 ? { scopes: [...granted].toSorted() } : {}),
      ...(permission.levels === undefined || permission.levels.length === 0
        ? {}
        : { levels: permission.levels }),
    };
  });
}

const RISKS: Readonly<
  Record<
    OperationRisk,
    NonNullable<NonNullable<AuthorizationOperation["meta"]>["risk"]>
  >
> = { low: "low", medium: "medium", high: "high", critical: "high" };

const EFFECTS: Readonly<
  Record<
    OperationEffect,
    NonNullable<NonNullable<AuthorizationOperation["meta"]>["effects"]>[number]
  >
> = {
  read: "read",
  write: "write",
  delete: "delete",
  send: "external",
  spend: "external",
  external: "external",
};

/**
 * The catalog's `defineOperations` entries as better-supabase operations. A
 * name with a `.` is used as written (`workflow.node.http`); any other is the
 * tool `ai.tool.<name>` and `mcp.tool.<name>`. `critical` risk is `high`, and
 * `send` and `spend` effects are `external`.
 */
function operationsOf(
  catalog: CatalogDocument,
): Record<string, AuthorizationOperation> {
  const operations: Record<string, AuthorizationOperation> = {};
  for (const operation of catalog.operations ?? []) {
    const effects = [
      ...new Set(
        (operation.meta.effects ?? []).map((effect) => EFFECTS[effect]),
      ),
    ];
    const meta = {
      ...(operation.meta.risk === undefined
        ? {}
        : { risk: RISKS[operation.meta.risk] }),
      ...(effects.length > 0 ? { effects } : {}),
      ...(operation.meta.title === undefined
        ? {}
        : { title: operation.meta.title }),
    };
    const entry: AuthorizationOperation = {
      permission: operation.permission,
      ...(Object.keys(meta).length > 0 ? { meta } : {}),
    };
    const names = operation.name.includes(".")
      ? [operation.name]
      : [`ai.tool.${operation.name}`, `mcp.tool.${operation.name}`];
    for (const name of names) operations[name] = entry;
  }
  return operations;
}

/**
 * better-supabase's `delegation.scopes`, the same map `rls.tokenScopes`
 * compiles.
 */
function delegatedScopes(
  catalog: CatalogDocument | undefined,
): Record<string, string[]> {
  return delegatedScopeMap(catalog?.permissions ?? [], catalog?.oauthScopes);
}

/**
 * better-supabase's `authorization` config value, built from PermDock's
 * manifest and catalog: the scopes, the `rls generate` helpers as SQL templates
 * (`providerFunctions`), the membership tables, suspension rows, the token hook
 * and every catalog key with `sqlComplete` set from its `rowConditions` and
 * `levels` from the catalog. `isApprover` is set with `approvers` or `approver`
 * and `permdock_is_approver`: `approver` fills its `'ai-tool'` entry.
 * `canApprove` is never set. `personas: 'roles'` is sent as written, with the
 * `fixtureRoles` the manifest names. Throws when the manifest or catalog is
 * invalid, or when the tenant scope is ambiguous.
 */
export function authorizationProvider<P = undefined>(
  options: AuthorizationProviderOptions<P>,
): AuthorizationProvider<ProviderKey<P>> {
  const manifest = parseSupabaseManifest(options.manifest);
  const catalog =
    options.catalog === undefined ? undefined : parseCatalog(options.catalog);
  const rls = manifest.rls;
  const problems: string[] = [];
  if (catalog === undefined) {
    problems.push(
      "No catalog: better-supabase cannot check that the permission keys its SQL modules use (ai_chat, workflow, inbox and the rest) exist. Pass `catalog`.",
    );
  }
  if (options.personas === "roles" && catalog === undefined) {
    problems.push(
      "personas: 'roles' needs a catalog of the policy's roles. Pass `catalog`.",
    );
  }
  const activeFrom = hasTokenHook(manifest)
    ? manifest.hook.activeFrom
    : undefined;
  if (options.activeTenant !== undefined && activeFrom !== undefined) {
    const mismatch = activeTenantMismatch(
      activeFrom,
      manifest.tenantClaim,
      options.activeTenant,
    );
    if (mismatch !== undefined) problems.push(mismatch);
  }
  const tenantScope = tenantScopeOf(manifest, options.scope);
  const scopeNames = rls.scopes.map((scope) => scope.name);
  const schema = sqlIdent(rls.schema);
  const rootTenant =
    rls.scopes.find((scope) => scope.name === tenantScope)?.within ===
    undefined;
  const assignAny = rls.customRoles === true && rootTenant;
  const { functions, requires, canAssign } = providerFunctions({
    manifest,
    catalog,
    options,
    tenantScope,
    rootTenant,
    assignAny,
    problems,
  });
  const memberships: AuthorizationMembership[] = [];
  const roleSources: AuthorizationRoleSource[] = [];
  for (const source of rls.memberships) {
    if (!covers(source, tenantScope)) continue;
    const membership = membershipOf(source, tenantScope, problems);
    if (membership) memberships.push(membership);
    const roleSource = roleSourceOf(source, catalog, rls.customRoleTenant);
    if (roleSource) roleSources.push(roleSource);
  }
  const users = rls.suspension?.users;
  const tenants = rls.suspension?.scopes?.[tenantScope];
  const platformRoles =
    options.platformRoles === false
      ? undefined
      : platformRolesOf(manifest, schema, tenantScope, assignAny && canAssign);
  const operations = catalog === undefined ? {} : operationsOf(catalog);
  const delegated = delegatedScopes(catalog);
  const interactiveOnly = (catalog?.permissions ?? [])
    .filter((permission) => permission.meta["interactiveOnly"] === true)
    .map((permission) => permission.key)
    .toSorted();
  const scopes = rls.scopes.map((scope) => {
    const idType =
      ID_TYPES[scope.type.trim().toLowerCase().replaceAll(/\s+/gu, " ")];
    if (idType === undefined) {
      problems.push(
        `Scope "${scope.name}" has ids of type ${scope.type}; better-supabase reads uuid, text, bigint and integer ids.`,
      );
    }
    return scope.within === undefined
      ? { name: scope.name, idType: idType ?? scope.type }
      : {
          name: scope.name,
          idType: idType ?? scope.type,
          parent: scope.within,
        };
  });
  const fixtureRoles =
    options.personas === "roles" && catalog !== undefined
      ? fixtureRolesOf(manifest, catalog, tenantScope, problems)
      : undefined;
  const personas =
    options.personas === "roles"
      ? fixtureRoles === undefined
        ? undefined
        : "roles"
      : options.personas?.length === 0
        ? undefined
        : options.personas;
  // SAFETY: a catalog built from `permissions` uses that tree's keys; without the tree the keys stay strings.
  return freezeDeep({
    apiVersion: 1,
    name: "PermDock",
    scopes,
    tenantScope,
    functions,
    requires,
    ...(catalog
      ? { permissions: permissionsOf(catalog, new Set(scopeNames)) }
      : {}),
    ...(memberships.length > 0 ? { memberships } : {}),
    ...(users || tenants
      ? {
          suspension: {
            ...(users ? { user: disabledRow(users), userKey: users.id } : {}),
            ...(tenants ? { tenant: disabledRow(tenants) } : {}),
          },
        }
      : {}),
    ...(roleSources.length > 0 ? { roleSources } : {}),
    ...(platformRoles === undefined ? {} : { platformRoles }),
    ...(personas === undefined ? {} : { personas }),
    ...(fixtureRoles === undefined ? {} : { fixtureRoles }),
    ...(Object.keys(operations).length > 0 ? { operations } : {}),
    ...(Object.keys(delegated).length > 0 || interactiveOnly.length > 0
      ? {
          delegation: {
            ...(Object.keys(delegated).length > 0 ? { scopes: delegated } : {}),
            ...(interactiveOnly.length > 0 ? { interactiveOnly } : {}),
          },
        }
      : {}),
    decidingColumns: manifest.decidingColumns,
    ...(hasTokenHook(manifest)
      ? { tokenHook: tokenHookOf(manifest, options.activeTenant) }
      : {}),
    ...(problems.length > 0 ? { problems } : {}),
  }) as AuthorizationProvider<ProviderKey<P>>;
}
