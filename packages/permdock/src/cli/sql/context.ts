import type { Scope } from "../../core/scopes.ts";
import type { ResourceNode } from "../../index.ts";
import type { SqlMembershipSource } from "../../supabase/sources.ts";
import type {
  GlobalRoles,
  RlsActions,
  RlsAssignmentTable,
  RlsCustomRoleAudit,
  RlsCustomRoleTable,
  RlsDialect,
  RlsMemberships,
  RlsMembershipTable,
  RlsSuspension,
} from "../types.ts";
import type { ResolvedVia } from "./tables.ts";

import { SQL_IDENT } from "../../core/sql.ts";

export const CLAIM: RegExp = SQL_IDENT;

export type RlsSqlContext = {
  readonly dialect: RlsDialect;
  /** `rls.anonymousSignIns`: `'deny'` keeps an `is_anonymous` token out of every branch but `anyone()`'s. */
  readonly anonymousSignIns?: "deny";
  /** The policy's scopes in order (the implicit `tenant` / `team` pair when it declares none). */
  readonly scopes: readonly Scope[];
  readonly memberships?: RlsMemberships;
  /**
   * `database` mode: the `tableMembershipSource` / `junctionMembershipSource` sources the helpers read
   * for a scope `memberships` maps no table for (the same SQL the hook runs).
   */
  readonly sources?: readonly SqlMembershipSource[];
  /**
   * `rls.membershipSources ?? supabase.hook.memberships` in either mode: what
   * `member_<scope>_ids_for(p_user)` reads for a scope `memberships` maps no table for.
   */
  readonly memberSources?: readonly SqlMembershipSource[];
  readonly tenantClaim: string;
  /** Scopes whose `member_<scope>_ids(p_roles text[])` overload `rls.migrate`'s `role` helpers rewrite to. */
  readonly roleMemberScopes?: readonly string[];
  /** `rls.roleValues`: a legacy role value to the PermDock role it is; the `role` shim maps through it. */
  readonly roleValues?: Readonly<Record<string, string>>;
  /**
   * SQL for the subject's user id in place of the dialect's (`auth.uid()`):
   * `p_user` inside a `_for` helper, which answers for a user the caller names.
   */
  readonly subjectId?: string;
  /**
   * `'all'` (`rls.tenants`): the helpers and `memberOf` checks admit every
   * tenant the subject holds a membership in, ignoring the tenant claim.
   * Unset, they narrow to the tenant claim when the token carries one.
   */
  readonly tenants?: "all";
  readonly grantSet?: true;
  readonly gucPrefix: string;
  /** `rls.actions`: verb to SQL command overrides. */
  readonly actions?: RlsActions;
  readonly inlineFunctions?: boolean;
  /** Schema of `role_permissions` and the RLS helpers (`permdock_has`, `permitted_<scope>_ids`). Default `permdock`, a schema the Data API does not expose. */
  readonly schema?: string;
  /** `rls.seeds: 'function'`: the `role_permissions` rows are written by `<schema>.seed()`; `'view'`: `role_permissions` is a view over them. */
  readonly seeds?: "function" | "view";
  /** Where the helpers read roles and memberships: tables (`database`) or claims (`jwt`, the default). */
  readonly authorize?: "database" | "jwt";
  /** Claim holding the global role (string or array). Default `user_role`. */
  readonly roleClaim?: string;
  /** Postgres type of the tenant column; the tenant claim is cast to it. Default `uuid`. */
  readonly tenantType?: string;
  /** Postgres type of the team column. Defaults to `tenantType`. */
  readonly teamType?: string;
  /** Postgres type of each scope's id column; overrides `tenantType` / `teamType`. */
  readonly scopeTypes?: Readonly<Record<string, string>>;
  /**
   * Set when custom roles compile: the helpers also resolve tenant-defined
   * roles, bounded by the ceiling of `assignable` declared roles.
   */
  readonly customRoles?: {
    readonly declared: readonly string[];
    readonly assignable: readonly string[];
    /** Former key to current key; a stored custom-role entry under a former key resolves like the current one. */
    readonly renamed?: Readonly<Record<string, string>>;
    /** Every declared permission key: a saved entry naming another key is `unknown-permission`. */
    readonly permissions?: readonly string[];
    /** Keys of permissions with `meta.manageRoles`: holding one lifts the hand-out check, as in-process. */
    readonly manage?: readonly string[];
    /** Keys of which the caller must hold one before any custom-role write (`rls.customRoleWrites.requires`). */
    readonly requires?: readonly string[];
    /** The application's roles table whose renames, moves and deletes cascade to the custom-role tables (`rls.customRoleWrites.roles`). */
    readonly table?: RlsCustomRoleTable;
    /** The function the by-id writers call after a save (`rls.customRoleWrites.audit`). */
    readonly audit?: RlsCustomRoleAudit;
    /**
     * Set when a resource declares levels: stored allows may carry a level
     * (`custom_role_permissions.level`, `key@level` in claims), and the
     * assignable roles' grants get one `<grant key>@<level>` key per level.
     */
    readonly levels?: true;
    /** The sync triggers (`rls.customRoles.from.sync`) as SQL, built from the legacy tables. */
    readonly sync?: string;
  };
  /** Set when link capabilities compile: resource-scoped grants also get `anon` branches. */
  readonly capabilities?: true;
  readonly apiKeys?: ApiKeysPlan;
  /** `rls.tokenScopes`: the scope-to-keys map a delegated token is narrowed by. */
  readonly tokenScopes?: TokenScopesPlan;
  /** Role ownership rules (`for`, `assigns`, `min`, `max`, `transferOnly`), when any role declares one. */
  readonly ownership?: RlsOwnership;
  /** Scopes whose holder-count and transfer-only triggers `rls.ownershipTriggers` leaves out; `'all'` for every scope. */
  readonly skipOwnershipTriggers?: "all" | readonly string[];
  /** `rls.assignments`: assignment triggers on the membership tables, the global-roles table and these extra tables. */
  readonly assignments?: {
    readonly tables: readonly RlsAssignmentTable[];
    readonly ownRole?: "refuse" | Readonly<Record<string, "refuse">>;
  };
  /**
   * Postgres types of the current table's columns, read from the resource
   * schema (`columnTypesOf`). A claim compared with a typed column is cast to
   * that type; a column without an entry compares as text.
   */
  readonly columnTypes?: Readonly<Record<string, string>>;
  /** Array columns of the table, each with its item type: `contains` on one compiles to `v = any(col)`. */
  readonly arrayColumns?: Readonly<Record<string, string>>;
  /** Active-row tables; scope keys are declared names (`checkSuspension` resolves aliases). */
  readonly suspension?: RlsSuspension;
  /** The permission key of the grant being compiled, for the suspension `keep` of its inline checks. */
  readonly permission?: string;
  /** `rls.roles`: the app's global-roles table, in place of the generated `user_roles`. */
  readonly roles?: GlobalRoles;
  /** Set when field views compile: grant keys also split by field set. */
  readonly fields?: "views";
  /** `rls.tables` entries with `via`, by resource: policies filter on the parent's id through `via.helper`. */
  readonly vias?: Readonly<Record<string, ResolvedVia>>;
  /** Graph grants: the closure depth kept for each walked resource. */
  readonly graph?: {
    readonly closures: Readonly<Record<string, number>>;
    /** The policy's resources, for link hops. */
    readonly resources?: ReadonlyMap<string, ResourceNode>;
    /** The table of each resource, as `rls.tables` maps it. */
    readonly tables?: Readonly<Record<string, string>>;
  };
};

export type ApiKeysPlan = {
  readonly claim: string;
  readonly scopes: string;
  readonly tenant: string;
  readonly roles: string;
  readonly serviceRoles: readonly string[];
  readonly renamed?: Readonly<Record<string, string>>;
};

export type TokenScopesPlan = {
  /** Each OAuth scope to the permission keys it reaches, from `delegatedScopeMap`. */
  readonly scopes: Readonly<Record<string, readonly string[]>>;
};

/** The policy's role ownership rules as the SQL generator needs them. */
export type RlsOwnership = {
  /** Role name to the membership kinds (`via`) that may hold it. */
  readonly kinds: Readonly<Record<string, readonly string[]>>;
  /**
   * Who assigns what: the assigner's scope (or `global`) is the target role's
   * scope or an ancestor of it. `at` is the target role's own scope, or
   * `global` for a global role, which only a global assigner may assign.
   */
  readonly assigns: readonly {
    readonly assigner: string;
    readonly scope: string;
    readonly role: string;
    readonly at: string;
  }[];
  /** Roles whose holder count per scope instance is constrained. */
  readonly counted: readonly {
    readonly role: string;
    readonly scope: string;
    readonly min: number;
    readonly max?: number;
    readonly transferOnly: boolean;
  }[];
};

/**
 * The permission an active-instance check is for: a key known when the SQL
 * is generated, or the SQL of one read at run time. Without one, a
 * suspended instance keeps nothing.
 */
export type CheckedPermission =
  | { readonly key: string }
  | { readonly sql: string };

export function parseMembershipsFlag(
  raw: string | undefined,
): RlsMemberships | undefined {
  if (raw === undefined || raw === "") {
    return undefined;
  }
  const colon = raw.indexOf(":");
  const table = colon === -1 ? raw : raw.slice(0, colon);
  const cols = (colon === -1 ? "" : raw.slice(colon + 1))
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
  const tenant: RlsMembershipTable = {
    table,
    tenant: cols[0] ?? "tenant_id",
    user: cols[1] ?? "user_id",
    role: cols[2] ?? "role",
    ...(cols[3] === undefined ? {} : { expiresAt: cols[3] }),
  };
  return { tenant };
}
