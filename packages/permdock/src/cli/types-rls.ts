import type { SqlMembershipSource } from "../supabase/sources.ts";
import type { RoleMap, RoleThrough } from "../supabase/types.ts";
import type { RlsApiKeys, RlsApprovalsAdopt } from "./types-rls-approvals.ts";
import type {
  GlobalRoles,
  RlsActions,
  RlsAssignmentTable,
  RlsAudit,
  RlsCustomRoleAudit,
  RlsCustomRoleTable,
  RlsCustomRolesConfig,
  RlsMigrateConfig,
  RlsShimsConfig,
  RlsTrigger,
} from "./types-rls-roles.ts";
import type { RlsRealtime, RlsStorage } from "./types-rls-surfaces.ts";

export type RlsDialect = "supabase" | "neon" | "guc";

export type RlsTarget = "sql" | "drizzle" | "prisma";

export type RlsMembershipTable = {
  readonly table: string;
  readonly user: string;
  /**
   * The role key column, a reference to a roles table that holds the key, or
   * several of them: the row holds every non-null key.
   */
  readonly role:
    | string
    | RoleMap
    | RoleThrough
    | readonly (string | RoleMap | RoleThrough)[];
  /**
   * Per scope name, the column holding that scope's id: the table's own scope
   * and its ancestors.
   */
  readonly columns?: Readonly<Record<string, string>>;
  readonly id?: string;
  readonly expiresAt?: string;
  readonly disabledAt?: string;
  /**
   * The membership kind (`Membership.via`) roles with `for` match: a column
   * holding it, or `{ value }` when every row has the same kind.
   */
  readonly via?: string | { readonly value: string };
};

export type RlsMemberships = {
  /** The membership table of each named scope. */
  readonly scopes?: Readonly<Record<string, RlsMembershipTable>>;
  readonly resource?: Readonly<Record<string, RlsMembershipTable>>;
};

/**
 * A table whose row says whether a user or a scope instance is active. A
 * missing row counts as suspended.
 */
export type RlsActiveRow = {
  readonly table: string;
  /** Column holding the user id or the scope instance id. */
  readonly id: string;
  /** Nullable timestamp column; a row with a value is suspended. */
  readonly disabledAt?: string;
  /** Status column; only a row whose value is in `active` counts as active. */
  readonly status?: string;
  readonly active?: readonly string[];
};

/**
 * A scope's active-row table, with the permissions its suspended instances
 * keep.
 */
export type RlsSuspendedScope = RlsActiveRow & {
  /**
   * Permissions (references or keys) members of a suspended instance, and of
   * every instance nested in it, still hold: restoring it, cancelling a
   * scheduled deletion, exporting before a purge.
   */
  readonly keep?: readonly (string | { readonly key: string })[];
};

export type RlsSuspendedMembership = {
  readonly keep?: readonly (string | { readonly key: string })[];
};

export type RlsSuspension = {
  /** A suspended user holds no role and no membership. */
  readonly users?: RlsActiveRow;
  /**
   * Per scope name: a suspended instance voids its memberships and every
   * membership nested under it, except for `keep`.
   */
  readonly scopes?: Readonly<Record<string, RlsSuspendedScope>>;
  readonly memberships?: RlsSuspendedMembership;
};

export type RlsFunctionMapping = {
  readonly twin: unknown;
  readonly args?: readonly string[];
};

/**
 * A table whose rows reach their scope through a parent table (`rls.tables`,
 * `via`): the table's `key` column holds the parent's id, and the parent's
 * `column` holds the scope instance id. The generated policies call
 * `permitted_<parent, singular>_ids(p_grant)`, a `security definer` helper that
 * joins the parent to `permitted_<scope>_ids`.
 */
export type RlsTableVia = {
  /** `schema.table` of the parent. */
  readonly table: string;
  /** The parent's column holding the scope instance id. */
  readonly column: string;
  /**
   * This table's column holding the parent's id. Default `<parent table,
   * singular>_id`.
   */
  readonly key?: string;
  /** The parent's id column. Default `id`. */
  readonly id?: string;
  /**
   * SQL type of the parent's id column. Default `uuid` in the `supabase`
   * dialect, else `text`.
   */
  readonly type?: string;
  /** The scope `column` holds. Default the policy's root scope. */
  readonly scope?: string;
};

/**
 * A resource's table. `false` is a resource with no table. `{ tableOf }` is the
 * older way to store a resource in another resource's table; `also` on the
 * owner replaces it. `follows` names child tables whose policies are an
 * `exists` of `can_<resource>` on this row. `walk: "recursive"` is the manager
 * chain: one recursive set helper.
 */
export type RlsTableOwner = {
  readonly table?: string;
  readonly via?: RlsTableVia;
  /** Other resources stored in this table. They get no policies of their own. */
  readonly also?: readonly string[];
  /**
   * Child table to the column that holds this resource's id. Each child gets
   * select, insert, update and delete policies that call `can_<resource>`.
   */
  readonly follows?: Readonly<Record<string, string>>;
  /** A self-parented resource walked as one recursive set, the manager chain. */
  readonly walk?: "recursive";
  /**
   * With `walk`, the column holding the row's user id, where the caller's walk
   * starts. The id column when unset, which suits a users table.
   */
  readonly user?: string;
};

export type RlsTable =
  | string
  | false
  | RlsTableOwner
  | { readonly tableOf: string };

export type RlsConfig = {
  /**
   * Per resource, the table its policies target; the table is named after the
   * resource when unset, and `false` means it has none.
   */
  readonly tables?: Readonly<Record<string, RlsTable>>;
  readonly dialect?: RlsDialect;
  readonly memberships?: RlsMemberships;
  /**
   * `database` mode: the `tableMembershipSource` / `junctionMembershipSource`
   * sources the helpers read for every scope `memberships` maps no table for.
   * Default `supabase.hook.memberships`, so the helpers and the token hook run
   * the same SQL. Setting it selects `database` mode.
   */
  readonly membershipSources?: readonly SqlMembershipSource[];
  /**
   * Tables the helpers, `authorize()` and the token hook read to drop suspended
   * users and scope instances.
   */
  readonly suspension?: RlsSuspension;
  readonly functions?: Readonly<Record<string, RlsFunctionMapping>>;
  readonly inlineFunctions?: boolean;
  /**
   * Emit FORCE ROW LEVEL SECURITY so the table owner is subject to the
   * policies.
   */
  readonly force?: boolean;
  readonly fixtures?: string;
  /**
   * `rls verify` findings accepted as a baseline. `id` is the
   * `<code>:<table>:<key>` the finding prints; `reason` is required. An entry
   * no finding matches is a warning, so the baseline shrinks.
   */
  readonly verify?: {
    readonly ignore?: readonly {
      readonly id: string;
      readonly reason: string;
    }[];
  };
  readonly tenantClaim?: string;
  /**
   * Which tenants the helpers and `memberOf` checks admit. `'active'`
   * (default): when the token carries a non-empty `tenantClaim`, only that
   * tenant; without one, every tenant the subject is a member of. `'all'`:
   * every such tenant whatever the claim says, for apps whose tenant comes from
   * the URL or the query.
   */
  readonly tenants?: "active" | "all";
  /**
   * Postgres type of each named scope's id column, `uuid` by default. The first
   * scope's type also types the tenant claim and the helper results cast to
   * it.
   */
  readonly scopeTypes?: Readonly<Record<string, string>>;
  /**
   * Postgres type of each resource's id in the `rls.rowHelpers` helpers
   * (`permitted_<resource>_rows` returns `setof <type>` and its `p_ids` takes
   * `<type>[]`), by resource name; `"*"` sets the default. Without it: `uuid`
   * on Supabase, `text` elsewhere.
   */
  readonly idTypes?: Readonly<Record<string, string>>;
  readonly roleClaim?: string;
  /**
   * Role values the existing SQL compares against (a string literal or an enum
   * label) and the PermDock role each one is. `rls import` writes the PermDock
   * name for a mapped value; `rls migrate` filters a `role` helper by it. An
   * unmapped value must already be a declared role.
   */
  readonly roleValues?: Readonly<Record<string, string>>;
  readonly gucPrefix?: string;
  readonly out?: string;
  /**
   * The parts `rls generate --split` writes when the flag is absent. The hook
   * part also moves `supabase.hook.out`'s default, read by `supabase inspect`
   * and doctor, to `out` with `{part}` replaced by `hook`.
   */
  readonly split?: readonly (
    | "helpers"
    | "seeds"
    | "indexes"
    | "policies"
    | "hook"
  )[];
  /** `--target drizzle`: where each policy's `.link()` finds its table. */
  readonly drizzle?: {
    /** Module exporting the tables, as imported from `out`. Default `./schema`. */
    readonly schema?: string;
    /**
     * Export name per table name; defaults to the camelCased table name without
     * its schema.
     */
    readonly exports?: Readonly<Record<string, string>>;
  };
  /** `--target prisma`: the model each table maps to. */
  readonly prisma?: {
    /**
     * Model name per table name; defaults to the PascalCased table name without
     * its schema.
     */
    readonly models?: Readonly<Record<string, string>>;
  };
  /**
   * Schema of `role_permissions` and the RLS helpers (`permdock_has`,
   * `permitted_<scope>_ids`, `member_<scope>_ids`) (and the RBAC scaffold).
   * Default `permdock`; keep it out of `[api] schemas`.
   */
  readonly schema?: string;
  /**
   * Where the helpers read roles and memberships: `database` tables or `jwt`
   * claims.
   */
  readonly authorize?: "database" | "jwt";
  /** One policy per role and permission instead of one per table and command. */
  readonly policyPerRole?: boolean;
  /**
   * Resolve tenant-defined custom roles in the helpers:
   * `custom_role_permissions` and `custom_role_includes` in `database` mode,
   * the `memberships[].grants` claim in `jwt` mode, always intersected with the
   * `permdock_ceiling` view. Off by default. An object turns them on and names
   * the application's existing role tables that `--backfill-out` copies from.
   */
  readonly customRoles?: boolean | RlsCustomRolesConfig;
  /**
   * Triggers the application owns on tables `generate` creates, by table name
   * without the schema (`custom_role_permissions`): written after the tables,
   * each as `drop trigger if exists` and `create trigger`.
   */
  readonly triggers?: Readonly<Record<string, readonly RlsTrigger[]>>;
  /**
   * Register generated tables with an audit function, such as
   * `better_supabase.audit`.
   */
  readonly audit?: RlsAudit;
  /**
   * How the generated custom-role write functions check the caller (`database`
   * mode with `customRoles`).
   */
  readonly customRoleWrites?: {
    /**
     * Who may change custom roles at all, checked before the hand-out check:
     * permission keys of which the caller must hold one in the tenant (or
     * through a global role; only through a global role for a platform custom
     * role), or `'manageRoles'` for any permission with `meta.manageRoles`.
     * Unset, any member may write a role within what they may hand out.
     */
    readonly requires?: "manageRoles" | readonly string[];
    /**
     * The application's own roles table, one row per custom role. A trigger on
     * it moves a role's grants and includes when the row's name, tenant, scope
     * or instance changes, and deletes them with the row. A signed-in caller
     * goes through the same checks as the write functions; a trusted path (a
     * migration, a job, a nested trigger) moves the rows directly.
     */
    readonly roles?: RlsCustomRoleTable;
    /**
     * The audit function the by-id writers call after a save
     * (`permdock_replace_custom_role_grants_by_id`), with `event_type`,
     * `target_type`, `record_id`, `tenant` and `metadata` plus `args`. Needs
     * `roles.primaryKey`.
     */
    readonly audit?: RlsCustomRoleAudit;
  };
  /**
   * Let link capabilities reach resource-scoped grants: `anon` policies that
   * call `permdock_capability_ids`, which reads the `capability` claim
   * `exchangeCapability` mints. Off by default.
   */
  readonly capabilities?: boolean;
  /**
   * `'deny'` (Supabase only): a token with `is_anonymous: true` reaches no
   * grant but those to `anyone()`. Supabase gives an anonymous sign-in the
   * `authenticated` role, so without it the grants to roles and to
   * `authenticated()` reach it. The subject mapper has to refuse it in process
   * too. Off by default.
   */
  readonly anonymousSignIns?: "deny";
  /**
   * Grant `anon` usage on the helper schema and `execute` on the helpers, for
   * hand-written policies that apply to `public` or `anon` and call them. They
   * find no subject for `anon` and return nothing. Off by default: a policy
   * that calls a helper says `to authenticated`.
   */
  readonly anonExecute?: boolean;
  /**
   * Check role assignments in the database: a trigger on each scope's
   * `rls.memberships` table, the global-roles table `rls.roles` and each table
   * in `tables` (such as invitations) refuses a client write that assigns,
   * changes or removes a role the caller may not assign there, by the policy's
   * `assigns` graph or, for a custom role, by what the caller may hand out.
   * Writes that do not run as a client role (the table owner, a `security
   * definer` function, a backend role) are trusted. Needs a role that declares
   * `assigns`.
   */
  readonly assignments?:
    | true
    | {
        readonly tables?: readonly RlsAssignmentTable[];
        /**
         * `'refuse'`: a client write to a row whose user is the caller is
         * refused on every guarded table with a user column, whatever the role.
         * A map refuses it on the tables it names (`schema.table` as
         * configured). Unset, a caller may change their own row within what
         * they may assign.
         */
        readonly ownRole?: "refuse" | Readonly<Record<string, "refuse">>;
      };
  /**
   * Add the approval store `supabaseApprovalStore` reads and writes: the
   * `approval_requests` table and one function per `ApprovalStore` method, in
   * the helper schema, executable by no client role. Off by default. An object
   * with `table` adopts a table the app already has instead, and `delegations:
   * true` adds the out-of-office covers.
   */
  readonly approvals?: boolean | RlsApprovalsAdopt;
  /**
   * A pg_jsonschema check constraint on the approval store's `body`: it must
   * match `approval-request-v1.json`. `true` installs the extension into
   * `extensions`. Off by default. `'auto'` is refused: it needed a `do` block.
   */
  readonly jsonSchema?: boolean;
  /**
   * `false` leaves out the holder-count and transfer-only triggers `min`, `max`
   * and `transferOnly` put on the membership tables; a map with `<scope>:
   * false` leaves them out for those scopes only. Those rules are then checked
   * by `decideRoleChange` alone. On by default.
   */
  readonly ownershipTriggers?: false | Readonly<Record<string, false>>;
  /**
   * Make a session acting for a user read-only in the database: one restrictive
   * policy per table and write command the generated policies allow, refusing
   * the write when the token's `act` claim names one of these actor kinds,
   * unless `act.read_only` is `false`. `true` is `['support',
   * 'impersonation']`; with `support`, an `act` with a `session_id` and no
   * `kind` counts too. Off by default.
   */
  readonly readOnlyActors?: boolean | readonly string[];
  readonly apiKeys?: true | RlsApiKeys;
  /**
   * Narrow a delegated token (a `client_id`, or an `act` that is not a support
   * or impersonation session) by its `scope` claim in every helper and policy:
   * a grant passes only when one of the token's scopes reaches its permission
   * (the permission's own scope, a former scope, or a policy `oauthScopes`
   * entry). Denies always apply. Off by default.
   */
  readonly tokenScopes?: boolean;
  /**
   * Supabase Realtime: policies on `realtime.messages` for private channels.
   * Supabase dialect only.
   */
  readonly realtime?: RlsRealtime;
  /**
   * Supabase Storage: policies on `storage.objects` for buckets keyed by a
   * scope folder. Supabase dialect only.
   */
  readonly storage?: RlsStorage;
  /**
   * `'views'`: one `security_invoker` view `<table>_visible` per table with
   * field-limited read grants, whose restricted columns are `case when
   * <permitted> then col end`. `'mask'`: the same views plus
   * `<schema>.<table>_mask(p_row)`, which nulls the restricted columns of one
   * row by the same masks, for SQL that reads the table without the view. Off
   * by default.
   */
  readonly fields?: "views" | "mask";
  /**
   * With `fields: 'views'` or `'mask'`, grant `anon` and `authenticated` only
   * the unrestricted columns of the base table, so restricted columns are read
   * through the view. Breaks `select *`.
   */
  readonly revokeColumns?: boolean;
  /**
   * Policy name template: `{table}`, `{op}`, plus `{role}` and `{permission}`
   * with `policyPerRole`.
   */
  readonly policyName?: string;
  /** `rls generate --rbac supabase` defaults; flags override. */
  readonly rbac?: {
    readonly schema?: string;
    readonly authorize?: "database" | "jwt";
  };
  /**
   * The global-roles table `permdock_has` reads in `database` mode. Default
   * `<schema>.user_roles (user_id, role)`, which the helpers create.
   */
  readonly roles?: GlobalRoles;
  /**
   * The SQL command each action verb compiles to, merged over the defaults
   * (`read`, `list`, `get` → `select`; `create` → `insert`; `update`;
   * `delete`). `'none'` compiles no policy. Every granted action is seeded into
   * `role_permissions` either way, so `permdock_has` answers for it.
   */
  readonly actions?: RlsActions;
  /**
   * Emit only the helpers, their seeds and the scaffold; the table policies
   * stay hand-written.
   */
  readonly helpersOnly?: boolean;
  /**
   * Where the transaction-local helper memos live. `'permdock'` reads and
   * writes `permdock.m.*` with `current_setting` and `set_config`, for the
   * scope helpers and the `rowHelpers` sets. `'better-supabase'` calls
   * `better_supabase.memo_get` and `memo_set`, so the memo shares
   * better-supabase's one mechanism; the keys stay `permdock.m.*`. Needs the
   * `better_supabase` schema. `'none'` (default) writes no memo: the helpers
   * are `language sql stable parallel safe`, and a policy's `id in (select
   * helper())` is one initPlan per statement.
   */
  readonly memo?: "permdock" | "better-supabase" | "none";
  /**
   * Emit `permitted_<resource>_rows(p_permission)`, its `_for` form,
   * `permitted_<resource>_rows(p_permission, p_ids)` limited to candidate ids
   * and `can_<resource>(p_row, p_permission)` for these resources, or for every
   * resource a grant reaches with `true`: the row ids the caller may act on, as
   * the generated policies decide them.
   */
  readonly rowHelpers?: true | readonly string[];
  /**
   * `'function'`: the `role_permissions` rows live in `<schema>.seed()`, which
   * the helpers part creates. Declarative workflows (pg-delta, migra) then need
   * no seeds migration: call `select <schema>.seed();` after each deploy.
   *
   * `'view'`: `role_permissions` is a `security_invoker` view over a `values`
   * list, so the rows travel with the declarative schema and need no seeding
   * step. Nothing can write the rows, so the view cannot take hand-added ones.
   */
  readonly seeds?: "function" | "view";
  /**
   * `'ref'`: the static grants are not in the generated SQL. The helpers pin
   * the hash of the policy bundle `permdock policy bundle` writes and read the
   * bundle from `<schema>.permdock_policy_bundle`; a bundle that is not loaded,
   * or has another hash, denies every static grant. `'inline'` (the default)
   * keeps the rows in the SQL as `rls.seeds` says. `'ref'` makes
   * `role_permissions` a view, so it cannot combine with `seeds: 'function'`.
   */
  readonly staticGrants?: "inline" | "ref";
  readonly trustedReaders?: readonly string[];
  readonly treeValues?: Readonly<
    Record<string, Readonly<Record<string, unknown>>>
  >;
  /** `rls migrate`: how existing helper calls map onto the generated helpers. */
  readonly migrate?: RlsMigrateConfig;
  /**
   * Emit a wrapper under each `migrate.helpers` name that answers from the
   * generated helpers, for legacy SQL `rls migrate` leaves alone. `true` puts
   * them in `public`. Off by default; `--shims` turns it on.
   */
  readonly shims?: boolean | RlsShimsConfig;
};
