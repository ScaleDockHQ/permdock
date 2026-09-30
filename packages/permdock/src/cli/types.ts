import type { ResourceRelation } from '../core/permissions.ts';
import type { SqlMembershipSource } from '../supabase/sources.ts';

export type CollectConfig = {
  readonly srcPath?: readonly string[];
  readonly out?: string;
  readonly barrel?: boolean | string;
};

export type CatalogConfig = {
  readonly out?: string;
};

export type RlsDialect = 'supabase' | 'neon' | 'guc';

export type RlsTarget = 'sql' | 'drizzle' | 'prisma';

export type RlsMembershipTable = {
  readonly table: string;
  readonly user: string;
  readonly role: string;
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
  /** Schema of `role_permissions` and the RLS helpers (`permdock_has`, `permitted_<scope>_ids`) (and the RBAC scaffold). Default `public`. */
  readonly schema?: string;
  /** Where the helpers read roles and memberships: `database` tables or `jwt` claims. */
  readonly authorize?: 'database' | 'jwt';
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
   * `'views'`: one `security_invoker` view `<table>_visible` per table with field-limited
   * read grants, whose restricted columns are `case when <permitted> then col end`. Off by default.
   */
  readonly fields?: 'views';
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
    readonly authorize?: 'database' | 'jwt';
  };
};

/** `permdock supabase hook generate` input. */
export type SupabaseHookConfig = {
  /** The same `fromTable` / `fromJunction` sources the app passes as `memberships`. */
  readonly memberships: readonly SqlMembershipSource[];
  /** Schema of the hook and the version table. Default `rls.schema`, else `public`. */
  readonly schema?: string;
  /** Global roles: `user_role` and `roles`. Default the `<schema>.user_roles (user_id, role)` table; `false` for none. */
  readonly roles?:
    | { readonly table: string; readonly user?: string; readonly role?: string }
    | false;
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
  readonly doctor?: DoctorConfig;
};

export type CatalogUsage = {
  readonly file: string;
  readonly line: number;
  readonly call: string;
};

export type CatalogPermission = {
  readonly key: string;
  readonly scope: string;
  readonly resource: string;
  readonly action: string;
  readonly arity: 'instance' | 'collection';
  readonly meta: Readonly<Record<string, unknown>>;
  readonly usages: readonly CatalogUsage[];
  /** Present only when the policy lists the permission in `hostable`. */
  readonly hostable?: true;
  /**
   * Present when the catalog was built with the policy: `true` when a code
   * grant for the key has a condition beyond role and scope, so the SQL
   * helpers alone cannot enforce it.
   */
  readonly rowConditions?: boolean;
  /** The approvals code allows on this permission require; a hosted grant must meet each. */
  readonly approvals?: readonly CatalogApproval[];
  /** Present when a `breakGlass` override targets this permission. */
  readonly breakGlass?: CatalogBreakGlass;
};

/** A break-glass override as the catalog carries it. */
export type CatalogBreakGlass = {
  readonly overrides: readonly string[];
  readonly purpose?: readonly string[];
  readonly reason: boolean;
  readonly maxDuration?: string;
  readonly obligations: readonly string[];
};

export type CatalogApproval =
  | 'human'
  | {
      readonly by?: unknown;
      readonly distinct?: boolean;
      readonly staleOn?: 'resource-change';
    };

export type CatalogResource = {
  readonly id: string;
  readonly schema: unknown;
  readonly definedIn?: string;
  readonly relations?: Readonly<Record<string, ResourceRelation>>;
  /** The row field an `approval: { staleOn: 'resource-change' }` binds to. */
  readonly version?: string;
  /** The boolean column that keeps ancestor grants out of a row. */
  readonly restricted?: string;
};

export type CatalogRole = {
  readonly key: string;
  /** A declared scope name, or `resource`; absent for a global role. */
  readonly on?: string;
  readonly assignable?: boolean;
  /** Fewest holders per scope instance; absent when 0. */
  readonly min?: number;
  readonly max?: number;
  readonly transferOnly?: true;
  readonly assigns?: readonly string[];
  /** Membership kinds (`via`) that may hold the role. */
  readonly for?: readonly string[];
  readonly exclusiveWith?: readonly string[];
  readonly audience?: string;
  /** Present when the role is eligible-only and activated with `permdock.activate`. */
  readonly activation?: CatalogActivation;
  /** Present when the role is a `supportAccess` role. */
  readonly supportAccess?: CatalogSupportAccess;
};

/** A role activation as the catalog carries it. */
export type CatalogActivation = {
  readonly maxDuration?: string;
  readonly justification: 'required' | 'optional';
  readonly approval?: boolean;
  readonly assurance?: {
    readonly maxAge?: number;
    readonly acr?: readonly string[];
    readonly amr?: readonly string[];
  };
};

/** A support-access role as the catalog carries it. */
export type CatalogSupportAccess = {
  readonly actorRequired: boolean;
  readonly group: string;
  readonly durations: readonly string[];
};

/** One declared scope, in declaration order. */
export type CatalogScope = {
  readonly name: string;
  readonly key: string;
  readonly within?: string;
};

export type CatalogDocument = {
  readonly $schema: string;
  readonly version: 1 | 2;
  readonly generatedAt: string;
  readonly generator: string;
  /** `catalogFingerprint` of this document; what hosted documents pin as `catalog`. */
  readonly fingerprint?: string;
  readonly resources: Readonly<Record<string, CatalogResource>>;
  readonly permissions: readonly CatalogPermission[];
  /** The policy's scopes in order; absent when it declares none. */
  readonly scopes?: readonly CatalogScope[];
  readonly roles?: readonly CatalogRole[];
  readonly plans?: readonly { readonly key: string }[];
};

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
};

export type RunResult = {
  readonly code: 0 | 1 | 2;
  readonly stdout: string;
  readonly stderr: string;
};

export type CreatePermDockPluginOptions = {
  readonly collect?: CollectConfig;
  readonly onDrift?: 'error' | 'warn';
  /**
   * Unplugin only: compare instead of write in `buildStart`, failing the
   * build on drift (as `permdock collect --check` does). The Next plugin
   * checks in `phase-production-build` unless `PERMDOCK_COLLECT=write`.
   */
  readonly check?: boolean;
};
