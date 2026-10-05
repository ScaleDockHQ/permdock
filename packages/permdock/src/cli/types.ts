import type { CatalogUsage } from "../catalog/types.ts";
import type { SqlMembershipSource } from "../supabase/sources.ts";
import type { RoleThrough } from "../supabase/types.ts";

export type { RoleThrough } from "../supabase/types.ts";

export type CollectConfig = {
  readonly srcPath?: readonly string[];
  readonly out?: string;
  readonly barrel?: boolean | string;
};

export type CatalogConfig = {
  readonly out?: string;
};

export type RlsDialect = "supabase" | "neon" | "guc";

export type RlsTarget = "sql" | "drizzle" | "prisma";

export type RlsMembershipTable = {
  readonly table: string;
  readonly user: string;
  /**
   * The role key column, a reference to a roles table that holds the key, or
   * several of them: the row holds every non-null key.
   */
  readonly role: string | RoleThrough | readonly (string | RoleThrough)[];
  /** Per scope name, the column holding that scope's id: the table's own scope and its ancestors. */
  readonly columns?: Readonly<Record<string, string>>;
  /** Column of the first scope's id; shorthand for `columns[<first scope>]`. */
  readonly tenant?: string;
  /** Column of the second scope's id; shorthand for `columns[<second scope>]`. */
  readonly team?: string;
  readonly id?: string;
  readonly expiresAt?: string;
  /** Column holding the membership kind (`Membership.via`); roles with `for` need it. */
  readonly via?: string;
};

export type RlsMemberships = {
  /** The membership table of each named scope. */
  readonly scopes?: Readonly<Record<string, RlsMembershipTable>>;
  /** The first scope's table; shorthand for `scopes[<first scope>]`. */
  readonly tenant?: RlsMembershipTable;
  /** The second scope's table; shorthand for `scopes[<second scope>]`. */
  readonly team?: RlsMembershipTable;
  readonly resource?: Readonly<Record<string, RlsMembershipTable>>;
};

/** A table whose row says whether a user or a scope instance is active. A missing row counts as suspended. */
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

export type RlsSuspension = {
  /** A suspended user holds no role and no membership. */
  readonly users?: RlsActiveRow;
  /** Per scope name: a suspended instance voids its memberships and every membership nested under it. */
  readonly scopes?: Readonly<Record<string, RlsActiveRow>>;
};

export type RlsFunctionMapping = {
  readonly twin: unknown;
  readonly args?: readonly string[];
};

export type RlsConfig = {
  readonly tables?: Readonly<Record<string, string>>;
  readonly dialect?: RlsDialect;
  readonly memberships?: RlsMemberships;
  /**
   * `database` mode: the `fromTable` / `fromJunction` sources the helpers
   * read for every scope `memberships` maps no table for. Default
   * `supabase.hook.memberships`, so the helpers and the token hook run the
   * same SQL. Setting it selects `database` mode.
   */
  readonly membershipSources?: readonly SqlMembershipSource[];
  /** Tables the helpers, `authorize()` and the token hook read to drop suspended users and scope instances. */
  readonly suspension?: RlsSuspension;
  readonly functions?: Readonly<Record<string, RlsFunctionMapping>>;
  readonly inlineFunctions?: boolean;
  /** Emit FORCE ROW LEVEL SECURITY so the table owner is subject to the policies. */
  readonly force?: boolean;
  readonly fixtures?: string;
  readonly tenantClaim?: string;
  /** Postgres type of tenant columns (`uuid` by default); the tenant claim and helper results are cast to it. */
  readonly tenantType?: string;
  /** Postgres type of team columns; defaults to `tenantType`. */
  readonly teamType?: string;
  /** Postgres type of each named scope's id column; overrides `tenantType` / `teamType`. */
  readonly scopeTypes?: Readonly<Record<string, string>>;
  readonly roleClaim?: string;
  readonly gucPrefix?: string;
  readonly out?: string;
  /** `--target drizzle`: where each policy's `.link()` finds its table. */
  readonly drizzle?: {
    /** Module exporting the tables, as imported from `out`. Default `./schema`. */
    readonly schema?: string;
    /** Export name per table name; defaults to the camelCased table name. */
    readonly exports?: Readonly<Record<string, string>>;
  };
  /** `--target prisma`: the model each table maps to. */
  readonly prisma?: {
    /** Model name per table name; defaults to the PascalCased table name. */
    readonly models?: Readonly<Record<string, string>>;
  };
  /** Schema of `role_permissions` and the RLS helpers (`permdock_has`, `permitted_<scope>_ids`, `member_<scope>_ids`) (and the RBAC scaffold). Default `permdock`; keep it out of `[api] schemas`. */
  readonly schema?: string;
  /** Where the helpers read roles and memberships: `database` tables or `jwt` claims. */
  readonly authorize?: "database" | "jwt";
  /** One policy per role and permission instead of one per table and command. */
  readonly policyPerRole?: boolean;
  /**
   * Resolve tenant-defined custom roles in the helpers: `custom_role_permissions` and
   * `custom_role_includes` in `database` mode, the `memberships[].grants` claim in `jwt` mode,
   * always intersected with the `permdock_ceiling` view. Off by default.
   */
  readonly customRoles?: boolean;
  /**
   * Let link capabilities reach resource-scoped grants: `anon` policies that call
   * `permdock_capability_ids`, which reads the `capability` claim `exchangeCapability`
   * mints. Off by default.
   */
  readonly capabilities?: boolean;
  /**
   * `'deny'` (Supabase only): a token with `is_anonymous: true` reaches no grant
   * but those to `anyone()`. Supabase gives an anonymous sign-in the
   * `authenticated` role, so without it the grants to roles and to
   * `authenticated()` reach it. The subject mapper has to refuse it in process
   * too. Off by default.
   */
  readonly anonymousSignIns?: "deny";
  /**
   * `'views'`: one `security_invoker` view `<table>_visible` per table with field-limited
   * read grants, whose restricted columns are `case when <permitted> then col end`. Off by default.
   */
  readonly fields?: "views";
  /**
   * With `fields: 'views'`, grant `anon` and `authenticated` only the unrestricted columns of
   * the base table, so restricted columns are read through the view. Breaks `select *`.
   */
  readonly revokeColumns?: boolean;
  /** Policy name template: `{table}`, `{op}`, plus `{role}` and `{permission}` with `policyPerRole`. */
  readonly policyName?: string;
  /** `rls generate --rbac supabase` defaults; flags override. */
  readonly rbac?: {
    readonly schema?: string;
    readonly authorize?: "database" | "jwt";
  };
  /** The global-roles table `permdock_has` reads in `database` mode. Default `<schema>.user_roles (user_id, role)`, which the helpers create. */
  readonly roles?: GlobalRoles;
  /**
   * The SQL command each action verb compiles to, merged over the defaults
   * (`read`, `list`, `get` → `select`; `create` → `insert`; `update`; `delete`).
   * `'none'` compiles no policy. Every granted action is seeded into
   * `role_permissions` either way, so `permdock_has` answers for it.
   */
  readonly actions?: RlsActions;
  /** Emit only the helpers, their seeds and the scaffold; the table policies stay hand-written. */
  readonly helpersOnly?: boolean;
  /** `rls migrate`: how existing helper calls map onto the generated helpers. */
  readonly migrate?: RlsMigrateConfig;
  /**
   * Emit a wrapper under each `migrate.helpers` name that answers from the
   * generated helpers, for legacy SQL `rls migrate` leaves alone. `true` puts
   * them in `public`. Off by default; `--shims` turns it on.
   */
  readonly shims?: boolean | RlsShimsConfig;
};

/** `rls.shims`: where the legacy-named wrappers go. */
export type RlsShimsConfig = {
  /** Schema of the legacy helpers. Default `public`. */
  readonly schema?: string;
};

/** An action verb's SQL command, or `'none'` for a verb that only `permdock_has` answers. */
export type RlsActions = Readonly<
  Record<string, "select" | "insert" | "update" | "delete" | "none">
>;

/**
 * One existing SQL helper `rls migrate` rewrites. `form` names its arguments:
 * `ids(key)` returns scope ids, `row(id, key)` and `membership(id)` test one id,
 * `scoped(scope, id, key)` takes the scope as a literal, `global(key)` returns a boolean.
 */
export type RlsMigrateHelper =
  | { readonly form: "ids" | "row" | "membership"; readonly scope: string }
  | { readonly form: "scoped" }
  | { readonly form: "global" };

export type RlsMigrateConfig = {
  /** By function name, without the schema. */
  readonly helpers: Readonly<Record<string, RlsMigrateHelper>>;
  /** Exact key renames, checked before `prefixes`. */
  readonly keys?: Readonly<Record<string, string>>;
  /** Key prefix renames, longest first: `{ 'organization.': '' }`. */
  readonly prefixes?: Readonly<Record<string, string>>;
  /** For `scoped` helpers, the scope literals that mean a global check, such as `system`. */
  readonly globalScopes?: readonly string[];
  /** For `scoped` helpers, a scope literal's PermDock scope when the names differ. */
  readonly scopes?: Readonly<Record<string, string>>;
};

/** Where global roles live: `table (user, role)`. Defaults `user_id` and `role`. */
export type GlobalRoles = {
  readonly table: string;
  readonly user?: string;
  readonly role?: string | RoleThrough;
};

/** `permdock supabase hook generate` input. */
export type SupabaseHookConfig = {
  /** The same `fromTable` / `fromJunction` sources the app passes as `memberships`. */
  readonly memberships: readonly SqlMembershipSource[];
  /** Schema of the hook and the version table. Default `rls.schema`, else `permdock`. */
  readonly schema?: string;
  /** Global roles: `user_role` and `roles`. Default `rls.roles`, else the `<schema>.user_roles (user_id, role)` table; `false` for none. */
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
   * Claims other packages own, each `claim: '<schema>.<function>'`, for
   * example `{ features: 'better_supabase.feature_claims' }`. The function
   * takes the user id (`uuid`) and returns `jsonb`; `null` omits the claim.
   * Reserved names are refused, the claims sit outside `budget`, and a
   * suspended user gets none.
   */
  readonly claims?: Readonly<Record<string, string>>;
  /** Bytes of JSON the `memberships` claim may use. Default `supabaseMembershipsBudget` (1024). */
  readonly budget?: number;
  /** Keep `permdock_authz_version` and write the `authz_ver` claim. Default `true`. */
  readonly version?: boolean;
  /** The `jwt_expiry` the printed `config.toml` block sets. Default 900. */
  readonly jwtExpiry?: number;
  /** Suspended users get empty claims. Default `rls.suspension`. */
  readonly suspension?: RlsSuspension;
  readonly out?: string;
};

export type SupabaseConfig = {
  readonly hook?: SupabaseHookConfig;
};

export type DoctorConfig = {
  readonly sensitiveActions?: readonly string[];
  readonly memberships?: string;
  /** A JSON fixture `{ credentials?, settings? }` of API-key credentials and per-tenant settings (the `memorySettings` input) for PD029. */
  readonly credentials?: string;
  /** Globs or directories whose files are client entries for PD001, for frameworks with no `'use client'` convention. */
  readonly clientEntries?: readonly string[];
  /** Globs or directories of SQL migrations PD022 scans for views; defaults to the usual migration folders. */
  readonly migrations?: readonly string[];
  /** A JSON array of sample decoded token claims; PD039 measures each `supabase.hook.claims` entry in it. */
  readonly claims?: string;
};

export type PermDockConfig = {
  readonly permissions?: string;
  readonly policy?: string;
  readonly collect?: CollectConfig;
  readonly catalog?: CatalogConfig;
  readonly openapi?: {
    readonly doc?: readonly string[];
  };
  readonly rls?: RlsConfig;
  readonly supabase?: SupabaseConfig;
  readonly powersync?: PowerSyncConfig;
  readonly doctor?: DoctorConfig;
};

/** `permdock powersync generate` and `verify` input. Tables and memberships come from `rls`. */
export type PowerSyncConfig = {
  /** The Sync Streams file; default `sync-config.yaml`. */
  readonly out?: string;
  /** Resources that get a stream; default every resource with a grant of `action`. */
  readonly resources?: readonly string[];
  /** The action whose grants decide which rows sync; default `read`. */
  readonly action?: string;
};

export type {
  CatalogActivation,
  CatalogApproval,
  CatalogBreakGlass,
  CatalogDelegation,
  CatalogDocument,
  CatalogGrant,
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
};

/** `include` is `undefined` for an unscoped call and `null` when it is not a literal list. */
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
  /** Styled human output; `--no-color` turns it off. Unset is plain. */
  readonly color?: boolean;
  /** A person at a terminal: commands may prompt. Unset never prompts. */
  readonly interactive?: boolean;
};

export type RunResult = {
  readonly code: 0 | 1 | 2;
  readonly stdout: string;
  readonly stderr: string;
};

export type PermDockPluginOptions = {
  readonly collect?: CollectConfig;
  readonly onDrift?: "error" | "warn";
  /**
   * Unplugin only: compare instead of write in `buildStart`, failing the
   * build on drift (as `permdock collect --check` does). The Next plugin
   * checks in `phase-production-build` unless `PERMDOCK_COLLECT=write`.
   */
  readonly check?: boolean;
};
