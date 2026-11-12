import type { RoleMap, RoleThrough } from "../supabase/types.ts";

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
