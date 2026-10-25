import type { CatalogUsage } from "../catalog/types.ts";
import type { SqlMembershipSource } from "../supabase/sources.ts";
import type { RoleMap, RoleThrough } from "../supabase/types.ts";
import type { ExitCode } from "./core/errors.ts";

export type { RoleMap, RoleThrough } from "../supabase/types.ts";

export type CollectConfig = {
  readonly srcPath?: readonly string[];
  readonly out?: string;
  readonly barrel?: boolean | string;
};

export type CatalogConfig = { readonly out?: string };

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
 * A resource's table: its `schema.table`, an object that adds `via`, or `false`
 * for a resource with no table (a console permission), which gets no policies
 * while its role grants are still seeded.
 */
export type RlsTable =
  | string
  | false
  | { readonly table?: string; readonly via: RlsTableVia };

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
   * A pg_jsonschema check constraint on generated `jsonb` columns: the approval
   * store's `body` must match `approval-request-v1.json`. `true` installs the
   * extension into `extensions`; `'auto'` adds the constraint only where
   * `pg_available_extensions` lists it. Off by default.
   */
  readonly jsonSchema?: "auto" | boolean;
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
   * Emit `permitted_<resource>_rows(p_permission)`, its `_for` form,
   * `permitted_<resource>_rows(p_permission, p_ids)` limited to candidate ids
   * and the row-valued `permitted_<resource>_row(p_row, p_permission)` for
   * these resources, or for every resource a grant reaches with `true`: the row
   * ids the caller may act on, as the generated policies decide them.
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

/**
 * `rls.approvals` on a table the app already has: the store functions keep each
 * request's body in `body` and its token in `token` (both added when missing)
 * and read every field from the body; `mirror` copies request fields into the
 * app's own columns on each write, converted to their types.
 */
export type RlsApprovalsAdopt = {
  /**
   * `table` or `schema.table`. Without it the store is the generated
   * `approval_requests`.
   */
  readonly table?: string;
  /**
   * Add `approval_delegations`, the out-of-office covers a user writes for
   * themselves, and the four-argument `permdock_is_approver` that answers for a
   * delegate inside an active cover. `tableApprovalDelegationSource` reads the
   * same rows for `approvalsHandler`. Off by default.
   */
  readonly delegations?: boolean;
  /** A text column unique per request. Default `token`. */
  readonly token?: string;
  /** A jsonb column holding the `ApprovalRequest`. Default `body`. */
  readonly body?: string;
  readonly open?: "insert" | "attach";
  readonly schema?: string;
  /** Request fields copied into the app's columns, field to column. */
  readonly mirror?: {
    readonly status?: string;
    readonly permission?: string;
    readonly tenant?: string;
    readonly principalId?: string;
    readonly actorId?: string;
    readonly session?: string;
    readonly approvals?: string;
    readonly createdAt?: string;
    readonly expiresAt?: string;
    readonly resolvedAt?: string;
    readonly resolvedBy?: string;
    readonly consumedAt?: string;
  };
};

export type RlsApiKeys = {
  readonly claim?: string;
  readonly scopes?: string;
  readonly tenant?: string;
  readonly roles?: string;
  readonly serviceRoles?: readonly string[];
};

/**
 * One more table whose rows assign a role, such as invitations
 * (`rls.assignments.tables`).
 */
export type RlsAssignmentTable = {
  readonly table: string;
  /** The declared scope the row assigns the role at. */
  readonly scope: string;
  /** The column holding the scope instance id. */
  readonly id: string;
  /**
   * The tenant column for a scope below the first; defaults to `id` at the
   * first scope.
   */
  readonly tenant?: string;
  /**
   * The role key column, a reference to a roles table that holds the key, or
   * several of them.
   */
  readonly role:
    | string
    | RoleMap
    | RoleThrough
    | readonly (string | RoleMap | RoleThrough)[];
  /**
   * The column holding the user the row assigns to, which `ownRole` compares
   * with the caller.
   */
  readonly user?: string;
};

/** `rls.customRoleWrites.roles`: the application's table of custom roles. */
export type RlsCustomRoleTable = {
  readonly table: string;
  /** The column holding the role name. */
  readonly key: string;
  /**
   * The tenant column; a row with no tenant is a platform custom role (`scope:
   * 'global'`). Without it every row is a platform role.
   */
  readonly tenant?: string;
  /**
   * A text column holding the scope name; without it a row with a tenant lives
   * at the first scope.
   */
  readonly scope?: string;
  /** A column pinning the role to one instance of its scope. */
  readonly id?: string;
  /**
   * The row's id column: turns on the by-id write and read functions
   * (`permdock_replace_custom_role_grants_by_id`).
   */
  readonly primaryKey?: string;
  /**
   * A boolean column marking rows that are not custom roles (declared or system
   * roles); those rows are skipped.
   */
  readonly skip?: string;
  /**
   * A boolean column marking a row with no tenant as a shared custom role, held
   * at `scope` (default the first scope) in every tenant. Without it a row with
   * no tenant is a platform role.
   */
  readonly shared?: string;
};

/**
 * `rls.customRoles` as an object: custom roles on, plus where existing ones
 * live.
 */
export type RlsCustomRolesConfig = {
  /**
   * The application's role tables `--backfill-out` copies into
   * `custom_role_permissions` and `custom_role_includes`.
   */
  readonly from?: RlsCustomRolesFrom;
};

/**
 * Existing custom-role data. Each row's role is a row of
 * `rls.customRoleWrites.roles`, which supplies its name, tenant, scope,
 * instance and `skip` flag.
 */
export type RlsCustomRolesFrom = {
  /**
   * `'trigger'`: after-row triggers on the permissions table and the includes
   * table rebuild the affected role through
   * `permdock_trusted_replace_custom_role_grants` on every legacy write, so the
   * PermDock grants follow the application's editor. Without it the backfill
   * copies once.
   */
  readonly sync?: "trigger";
  readonly permissions: {
    /** `table` or `schema.table`: one row per permission a role holds. */
    readonly table: string;
    /**
     * The reference to the roles table: `{ through: 'roles', on: { role_id:
     * 'id' }, column: 'key' }`.
     */
    readonly role: RoleThrough;
    /**
     * The permission key column, or a reference to a permissions table that
     * holds the key.
     */
    readonly permission: string | RoleThrough;
    /** A text column holding `allow` or `deny`. Without it every row allows. */
    readonly effect?: string;
    /** A text column holding the level of a leveled allow. */
    readonly level?: string;
  };
  readonly includes?: {
    readonly table: string;
    /** The reference to the including role's row in the roles table. */
    readonly role: RoleThrough;
    /** The included role's key column, or a reference to the roles table. */
    readonly include: string | RoleThrough;
  };
};

/** One trigger the application owns on a generated table (`rls.triggers`). */
export type RlsTrigger = {
  /** The trigger name; `permdock_` is reserved for generated triggers. */
  readonly name: string;
  readonly when: "before" | "after";
  readonly events: readonly ("insert" | "update" | "delete" | "truncate")[];
  /** Default `row`. */
  readonly level?: "row" | "statement";
  /** `schema.function`, a trigger function that already exists. */
  readonly function: string;
  /** String arguments passed to the trigger function. */
  readonly args?: readonly string[];
};

/**
 * `rls.audit`: one `select <function>('<schema>.<table>'::regclass, <args>)`
 * per generated table, for an audit module that registers a table by creating
 * its own trigger.
 */
export type RlsAudit = {
  /** `schema.function` taking the table as its first argument. */
  readonly function: string;
  /**
   * Generated tables, without the schema. Default the custom-role tables and
   * `user_roles`, those this run creates.
   */
  readonly tables?: readonly string[];
  /**
   * Named text arguments: `{ tenant_column: 'tenant_id' }` passes
   * `tenant_column => 'tenant_id'`.
   */
  readonly args?: Readonly<Record<string, string>>;
};

/** `rls.customRoleWrites.audit`: the function a by-id custom-role save calls. */
export type RlsCustomRoleAudit = {
  /**
   * `schema.function` taking named `event_type`, `target_type`, `record_id`,
   * `tenant` and `metadata` arguments.
   */
  readonly function: string;
  /**
   * Extra named text arguments: `{ actor_kind: 'user' }` passes `actor_kind =>
   * 'user'`.
   */
  readonly args?: Readonly<Record<string, string>>;
};

/** `rls.shims`: where the legacy-named wrappers go. */
export type RlsShimsConfig = {
  /** Schema of the legacy helpers. Default `public`. */
  readonly schema?: string;
};

/**
 * An action verb's SQL command, or `'none'` for a verb that only `permdock_has`
 * answers.
 */
export type RlsActions = Readonly<
  Record<string, "select" | "insert" | "update" | "delete" | "none">
>;

/**
 * One existing SQL helper `rls migrate` rewrites. `form` names its arguments:
 * `ids(key)` returns scope ids, `row(id, key)` and `membership(id)` test one
 * id, `scoped(scope, id, key)` takes the scope as a literal, `global(key)`
 * returns a boolean.
 */
export type RlsMigrateHelper =
  | { readonly form: "ids" | "row" | "membership"; readonly scope: string }
  /**
   * `role(id, 'role', …)`: the subject holds one of the named roles on instance
   * `id`.
   */
  | { readonly form: "role"; readonly scope: string }
  | { readonly form: "scoped" }
  | { readonly form: "global" };

export type RlsMigrateConfig = {
  /** By function name, without the schema. */
  readonly helpers: Readonly<Record<string, RlsMigrateHelper>>;
  /** Exact key renames, checked before `prefixes`. */
  readonly keys?: Readonly<Record<string, string>>;
  /** Key prefix renames, longest first: `{ 'organization.': '' }`. */
  readonly prefixes?: Readonly<Record<string, string>>;
  /**
   * For `scoped` helpers, the scope literals that mean a global check, such as
   * `system`.
   */
  readonly globalScopes?: readonly string[];
  /**
   * For `scoped` helpers, a scope literal's PermDock scope when the names
   * differ.
   */
  readonly scopes?: Readonly<Record<string, string>>;
  /**
   * Materialised permission tables to retire, by `schema.table`: a table the
   * application keeps in step with triggers and reads instead of the grants.
   * `rls migrate --retire-out` drops it with its refresh triggers once nothing
   * else reads it.
   */
  readonly tables?: Readonly<Record<string, RlsMigrateTable>>;
};

export type RlsMigrateTable = {
  /**
   * The functions that keep the table in step. Default: every function in
   * `--sql` whose body writes it, and every function that calls one.
   */
  readonly refresh?: readonly string[];
};

/** Where global roles live: `table (user, role)`. Defaults `user_id` and `role`. */
export type GlobalRoles = {
  readonly table: string;
  readonly user?: string;
  readonly role?: string | RoleThrough;
};

/** A permission reference from the app's definitions; only its `key` is read. */
export type RlsPermissionRef = { readonly key: string };

/**
 * One private Realtime topic pattern, such as `org:{organization}:chat`:
 * `:`-separated segments, one of them `{<scope>}`, which holds the id of a
 * scope instance.
 */
export type RlsRealtimeTopic = {
  /** Receive broadcast and presence messages: `select` on `realtime.messages`. */
  readonly read: RlsPermissionRef;
  /** Send broadcast messages and track presence: `insert`. Absent: nobody may. */
  readonly write?: RlsPermissionRef;
};

export type RlsRealtime = {
  readonly topics: Readonly<Record<string, RlsRealtimeTopic>>;
};

/** One Storage bucket whose object paths start with a scope instance id. */
export type RlsStorageBucket = {
  readonly scope: string;
  /** The 1-based `storage.foldername(name)` entry that holds the id. Default 1. */
  readonly folder?: number;
  /** Download and list: `select` on `storage.objects`. */
  readonly read?: RlsPermissionRef;
  /** Upload and overwrite: `insert` and `update`. */
  readonly write?: RlsPermissionRef;
  readonly delete?: RlsPermissionRef;
};

export type RlsStorage = {
  readonly buckets: Readonly<Record<string, RlsStorageBucket>>;
};

/** `permdock supabase hook generate` input. */
export type SupabaseHookConfig = {
  /**
   * The same `tableMembershipSource` / `junctionMembershipSource` sources the
   * app passes as `memberships`.
   */
  readonly memberships: readonly SqlMembershipSource[];
  /**
   * Schema of the hook and the version table. Default `rls.schema`, else
   * `permdock`.
   */
  readonly schema?: string;
  /**
   * Global roles: `user_role` and `roles`. Default `rls.roles`, else the
   * `<schema>.user_roles (user_id, role)` table; `false` for none.
   */
  readonly roles?: GlobalRoles | false;
  /**
   * Where the active first-scope id comes from: `app_metadata.<key>` (default
   * `app_metadata.active_<first scope>`), `<table>.<column>` joined on `id`, or
   * `{ table, id, column }`.
   */
  readonly activeFrom?:
    | string
    | { readonly table: string; readonly id?: string; readonly column: string };
  /**
   * The `attrs` claim, for attribute conditions such as
   * `principal.claims.attrs.region`: allow-listed columns of a server-owned
   * table (`table`, joined on `id`), and `app_metadata.<key>` entries. Never
   * `user_metadata`; the migration fails when clients can write a column.
   */
  readonly attrs?: {
    readonly table?: string;
    readonly id?: string;
    readonly columns: readonly string[];
  };
  /**
   * Claims other packages own, each `claim: '<schema>.<function>'`, for example
   * `{ features: 'public.feature_claims' }`. The function takes the user id
   * (`uuid`) and returns `jsonb`; `null` omits the claim. Reserved names are
   * refused, the claims sit outside `budget`, and a suspended user gets none.
   */
  readonly claims?: Readonly<Record<string, string>>;
  /**
   * The `team_ids` claim: the uuid of every team the user belongs to, read from
   * `table` (`user` and `team` columns; `tenant` puts the active tenant's teams
   * first). It shares the `memberships` budget, so a user with many teams gets
   * a prefix and `memberships_truncated`. A suspended user gets none. Clients
   * must not write the table.
   */
  readonly teams?: {
    readonly table: string;
    readonly user: string;
    readonly team: string;
    readonly tenant?: string;
  };
  readonly before?: string | readonly string[];
  /**
   * Check the claims the hook wrote against `supabase-claims-v1.json` with
   * pg_jsonschema, and drop them all on a mismatch so the user signs in with no
   * PermDock access instead of an error. Needs the extension. Default `false`.
   */
  readonly validate?: boolean;
  /**
   * Bytes of JSON the `memberships` claim may use. Default
   * `supabaseMembershipsBudget` (1024).
   */
  readonly budget?: number;
  /**
   * Keep `permdock_authz_version` and write the `authz_ver` claim. Default
   * `true`.
   */
  readonly version?: boolean;
  /**
   * Write PostgREST wrappers for `subject_for`, `members_of` and
   * `authz_version_for` into `schema` (default `public`), named
   * `<prefix>subject_for` and so on (default prefix `permdock_`), for a backend
   * that reaches Postgres through the Data API while the hook schema is not
   * exposed. Each wrapper is `security definer`, revoked from `public`, `anon`
   * and `authenticated`, and granted to `service_role`: the one place the hook
   * grants to it. Pass the same setting to `postgrestSources`.
   */
  readonly api?: { readonly schema?: string; readonly prefix?: string };
  /** The `jwt_expiry` the printed `config.toml` block sets. Default 900. */
  readonly jwtExpiry?: number;
  /** Suspended users get empty claims. Default `rls.suspension`. */
  readonly suspension?: RlsSuspension;
  readonly out?: string;
};

/**
 * How the project turns SQL into Supabase migrations: `'pg-delta'` (Declarative
 * Schemas 2.0, `supabase db schema declarative sync`), `'migra'` (declarative
 * schemas on `supabase db diff`) or `'migrations'` (hand-written migrations, no
 * declarative schemas).
 */
export type SupabaseSchemas = "pg-delta" | "migra" | "migrations";

export type SupabaseConfig = {
  readonly hook?: SupabaseHookConfig;
  /**
   * The schema workflow `rls generate --split`, `supabase hook generate` and
   * doctor follow. Default: `'migra'` when `supabase/config.toml` sets
   * `[experimental.pgdelta] enabled = false`, else `'pg-delta'`.
   */
  readonly schemas?: SupabaseSchemas;
};

export type DoctorConfig = {
  /**
   * Directories or globs the source checks read (PD001, PD002, PD007 to PD015,
   * PD044 and the other checks over files), default `collect.srcPath`. The
   * catalog `collect` writes still comes from `collect.srcPath`, and PD004
   * compares the catalog on disk with that one.
   */
  readonly srcPath?: readonly string[];
  readonly sensitiveActions?: readonly string[];
  readonly memberships?: string;
  /**
   * A JSON fixture `{ credentials?, settings? }` of API-key credentials and
   * per-tenant settings (the `memorySettingsSource` input) for PD029.
   */
  readonly credentials?: string;
  /**
   * Globs or directories whose files are client entries for PD001, for
   * frameworks with no `'use client'` convention.
   */
  readonly clientEntries?: readonly string[];
  /**
   * Globs or directories of SQL migrations PD022 scans for views; defaults to
   * the usual migration folders.
   */
  readonly migrations?: readonly string[];
  /**
   * A JSON array of sample decoded token claims; PD039 measures each
   * `supabase.hook.claims` entry in it.
   */
  readonly claims?: string;
  /**
   * Tables two resources map to on purpose, over disjoint rows; PD075 skips
   * them.
   */
  readonly sharedTables?: readonly string[];
};

export type PermDockConfig = {
  readonly permissions?: string;
  readonly policy?: string;
  /**
   * A module exporting the `defineOperations` map as `operations` or default;
   * `collect` writes it to the catalog's `operations`.
   */
  readonly operations?: string;
  readonly collect?: CollectConfig;
  readonly catalog?: CatalogConfig;
  readonly openapi?: { readonly doc?: readonly string[] };
  readonly rls?: RlsConfig;
  readonly supabase?: SupabaseConfig;
  readonly powersync?: PowerSyncConfig;
  readonly doctor?: DoctorConfig;
  readonly gen?: GenConfig;
};

/** What `permdock gen --kind` writes. */
export type GenKind =
  | "zod"
  | "valibot"
  | "arktype"
  | "json-schema"
  | "standard-schema"
  | "constants"
  | "factories"
  | "react"
  | "vue"
  | "svelte"
  | "solid"
  | "messages";

/** `permdock gen` input. */
export type GenConfig = {
  /** The directory the generated files go to; default `src/generated`. */
  readonly out?: string;
  /** The kinds `permdock gen` writes without `--kind`; default `['constants']`. */
  readonly kinds?: readonly GenKind[];
  /**
   * The schema kinds also export `<resource>Fields`: per field its `label`,
   * `required`, enum `options` and bounds, for forms.
   */
  readonly fieldMeta?: boolean;
};

/**
 * `permdock powersync generate` and `verify` input. Tables and memberships come
 * from `rls`.
 */
export type PowerSyncConfig = {
  /** The Sync Streams file; default `sync-config.yaml`. */
  readonly out?: string;
  /**
   * Resources that get a stream; default every resource with a grant of
   * `action`.
   */
  readonly resources?: readonly string[];
  /** The action whose grants decide which rows sync; default `read`. */
  readonly action?: string;
  /**
   * Where `generate` writes `localSnapshotManifest(policy)` as JSON for
   * `localSnapshot` and `powerSyncSource`; none by default.
   */
  readonly manifest?: string;
  /**
   * Tables that are not resources, by `schema.table`, each synced as its own
   * stream: the user's own rows, the rows that point at a resource row the user
   * reads, or both.
   */
  readonly tables?: Readonly<Record<string, PowerSyncTable>>;
};

export type PowerSyncTable = {
  /** The user id column: the stream holds the rows whose column is the user. */
  readonly user?: string;
  /** The resources a row points at; the stream holds rows of any of them. */
  readonly follow?: readonly PowerSyncFollow[];
};

/**
 * A row points at a `resource` row through `field`, which holds its id; `match`
 * keeps the rows whose columns equal the given values, for a table whose rows
 * point at several resources.
 */
export type PowerSyncFollow = {
  readonly resource: string;
  readonly field: string;
  readonly match?: Readonly<Record<string, string>>;
};

export type {
  CatalogActivation,
  CatalogApproval,
  CatalogBreakGlass,
  CatalogDelegation,
  CatalogDocument,
  CatalogGrant,
  CatalogOAuthScope,
  CatalogOperation,
  CatalogPermission,
  CatalogResource,
  CatalogRole,
  CatalogScope,
  CatalogSupportAccess,
  CatalogUsage,
} from "../catalog/types.ts";

export type DynamicUsage = {
  readonly file: string;
  readonly line: number;
  readonly call: string;
};

export type ScanResult = {
  readonly roots: readonly string[];
  readonly definitionFiles: Readonly<Record<string, string>>;
  readonly usages: Readonly<Record<string, readonly CatalogUsage[]>>;
  readonly unknown: readonly CatalogUsage[];
  readonly dynamic: readonly DynamicUsage[];
  readonly roleNames: readonly string[];
  readonly planNames: readonly string[];
  readonly allowKeys: readonly string[];
  readonly snapshots: readonly SnapshotSite[];
  /** Files under `srcPath` with a syntax error; the scan covers what parsed. */
  readonly unparsed: readonly UnparsedSource[];
};

export type UnparsedSource = {
  readonly file: string;
  readonly line: number;
  readonly message: string;
};

/**
 * `include` is `undefined` for an unscoped call and `null` when it is not a
 * literal list.
 */
export type SnapshotSite = {
  readonly file: string;
  readonly line: number;
  readonly include: readonly string[] | null | undefined;
};

export type CliIo = {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly now?: () => Date;
  readonly fetch?: typeof fetch;
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Styled stdout; `--no-color` turns it off. Unset is plain. */
  readonly color?: boolean;
  /** Styled stderr, decided for that stream on its own. Unset is plain. */
  readonly errColor?: boolean;
  /** A person at a terminal: commands may prompt. Unset never prompts. */
  readonly interactive?: boolean;
  /** stdout is a terminal; agent detection reads it. Unset is a pipe. */
  readonly stdoutIsTty?: boolean;
  /** stderr is a terminal: progress draws a spinner. Unset prints lines. */
  readonly stderrIsTty?: boolean;
  /** Reads all of stdin, for `--*-stdin` secrets. Unset reads nothing. */
  readonly readStdin?: () => Promise<string>;
  /** Aborted on SIGINT or SIGTERM. */
  readonly signal?: AbortSignal;
};

export type RunResult = {
  readonly code: ExitCode;
  readonly stdout: string;
  readonly stderr: string;
};

export type PermDockPluginOptions = {
  readonly collect?: CollectConfig;
  readonly onDrift?: "error" | "warn";
  /**
   * Unplugin only: compare instead of write in `buildStart`, failing the build
   * on drift (as `permdock collect --check` does). The Next plugin checks in
   * `phase-production-build` unless `PERMDOCK_COLLECT=write`.
   */
  readonly check?: boolean;
};
