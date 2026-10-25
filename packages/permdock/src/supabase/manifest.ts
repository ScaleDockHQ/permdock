import type { StandardSchemaV1 } from "@standard-schema/spec";

import { freezeDeep } from "../core/freeze.ts";
import { checkSchema, copyJson } from "../core/json-schema.ts";
import { PermDockValidationError } from "../core/validation-error.ts";
import { supabaseManifestSchema } from "./manifest-schema.ts";

/**
 * What `permdock supabase inspect --json` prints and `--out` writes to
 * `permdock.manifest.json`: the contract between the generated hook and SQL
 * helpers and a package that writes policies or claims next to them. `version`
 * is the major of this shape; a field is only ever added within it.
 * `schemas/supabase-manifest-v1.json` is its JSON Schema.
 */
/** An `app_metadata` key, or a column of a table joined on `id`. */
export type SupabaseManifestActiveFrom =
  | { readonly appMetadata: string }
  | { readonly table: string; readonly column: string; readonly id: string };

export type SupabaseHookManifest = {
  readonly $schema: "https://permdock.com/schemas/supabase-manifest-v1.json";
  readonly version: 1;
  readonly hook: {
    readonly schema: string;
    readonly function: "custom_access_token_hook";
    readonly out: string;
    /**
     * How the project turns SQL into migrations: `pg-delta` (`supabase db
     * schema declarative sync`, which keeps the hook's grants in `out`),
     * `migra` (`supabase db diff`, which drops them) or `migrations`
     * (hand-written). Absent means `pg-delta`.
     */
    readonly schemas?: "pg-delta" | "migra" | "migrations";
    readonly before?: readonly string[];
    /**
     * Where the hook reads the active first-scope id
     * (`supabase.hook.activeFrom`). Absent from a manifest written before
     * 0.10.
     */
    readonly activeFrom?: SupabaseManifestActiveFrom;
  };
  readonly helpers: {
    readonly schema: string;
    /**
     * `permdock_has` and, per declared scope, `permitted_<scope>_ids`, each
     * `(p_grant text)`, the membership-only `member_<scope>_ids()` and, for a
     * scope with a membership source, `member_<scope>_ids_for(p_user uuid)`.
     */
    readonly functions: readonly string[];
  };
  readonly tenantClaim: string;
  readonly budget: { readonly bytes: number; readonly measure: string };
  readonly claims: readonly SupabaseHookClaim[];
  readonly authzVersion: boolean;
  /**
   * With `authzVersion`, the function that bumps the listed users' `authz_ver`,
   * for a membership source outside the hook. It is `security definer` and no
   * client role may execute it: call it from a trigger owned by the table's
   * owner.
   */
  readonly authzVersionBump?: {
    readonly schema: string;
    readonly function: "permdock_bump_authz_version_for";
    readonly args: "p_users uuid[]";
  };
  /**
   * The Management API fields that make a hosted project call the hook;
   * `permdock supabase inspect` adds them.
   */
  readonly managementApi?: {
    readonly hook_custom_access_token_enabled: true;
    readonly hook_custom_access_token_uri: string;
    readonly jwt_exp: number;
  };
  /** The `supabase.hook.memberships` sources, in the order the hook reads them. */
  readonly memberships: readonly SupabaseManifestMembership[];
  readonly rls: SupabaseManifestRls;
  /**
   * Every `schema.table.column` a membership or an `attrs` claim is computed
   * from. A client role that can insert or update one can grant itself access.
   */
  readonly decidingColumns: readonly string[];
  /** The majors of the `-- permdock:hook` and `-- permdock:grants` marker lines. */
  readonly markers: { readonly hook: "v1"; readonly grants: "v1" };
  /**
   * The `supabase/sdk` capability-matrix feature ids the hook, the helpers and
   * `subjectFromSupabase` depend on, as of the `matrix` release tag. A client
   * SDK that lacks one cannot serve this policy.
   */
  readonly requires?: SupabaseManifestRequires;
  /**
   * The SQL names the generated RLS exposes, as `resolveNames` gives them.
   * Absent from a manifest written before 0.8.
   */
  readonly names?: SupabaseManifestNames;
};

/** The SQL helpers named after one scope, unqualified. */
export type SupabaseManifestScopeNames = {
  readonly permittedIds: string;
  readonly permittedIdsFor: string;
  readonly memberIds: string;
  readonly memberIdsFor: string;
  /**
   * Only on the team scope (`team` or `teams`), for better-supabase's
   * `teamIdsOf`.
   */
  readonly memberIdsOf?: string;
  readonly permittedUsers: string;
};

/** The SQL objects named after one resource, unqualified. */
export type SupabaseManifestResourceNames = {
  /** The table `rls.tables` maps, as written there. */
  readonly table?: string;
  /** Graph resources only: `permitted_<resource>_ids` and its restriction check. */
  readonly permittedIds?: string;
  readonly restricted?: string;
  /** With `rls.rowHelpers` naming the resource. */
  readonly rows?: string;
  readonly row?: string;
  /** With `rls.fields` and a mapped table. */
  readonly visible?: string;
  readonly visibleFields?: string;
  readonly mask?: string;
};

export type SupabaseManifestNames = {
  readonly schema: string;
  readonly gucPrefix: string;
  readonly claims: { readonly tenant: string; readonly role: string };
  /** The scope better-supabase reads as its teams, when one is declared. */
  readonly teamScope?: string;
  readonly scopes: Readonly<Record<string, SupabaseManifestScopeNames>>;
  readonly resources: Readonly<Record<string, SupabaseManifestResourceNames>>;
};

export type SupabaseManifestRequires = {
  /** The capability-matrix release tag, `capability-matrix-v1.<minor>.<patch>`. */
  readonly matrix: string;
  /** Sorted three-segment feature ids, such as `auth.session.get_claims`. */
  readonly capabilities: readonly string[];
};

export type SupabaseHookClaim = {
  readonly name: string;
  /** `permdock`, or the `<schema>.<function>` of a `supabase.hook.claims` entry. */
  readonly source: string;
  /** Whether the claim counts toward `budget.bytes`. */
  readonly budget: boolean;
};

export type SupabaseManifestColumn = { readonly column: string };

/** A column of the source table, or a value every row has. */
export type SupabaseManifestValue =
  | SupabaseManifestColumn
  | { readonly value: string | readonly string[] };

/**
 * A column that references another table: the value (role key or user id) is
 * `column` of `table`, matched on `id`.
 */
export type SupabaseManifestThrough = {
  readonly table: string;
  readonly id: string;
  readonly column: string;
  /**
   * Every referencing column to the column of `table` it matches, when the
   * reference spans several columns (a role set keyed by scope id and user).
   */
  readonly on?: Readonly<Record<string, string>>;
};

/**
 * A role column (with `through` when it references a roles table), or the fixed
 * roles every row holds.
 */
export type SupabaseManifestRole =
  | SupabaseManifestValue
  | (SupabaseManifestColumn & { readonly through: SupabaseManifestThrough })
  | (SupabaseManifestColumn & {
      /**
       * Each column value to the role key it stands for, or `null` for no role;
       * an unlisted value is no role.
       */
      readonly map: Readonly<Record<string, string | null>>;
    });

/** One `tableMembershipSource` or `junctionMembershipSource` source. */
export type SupabaseManifestMembership = {
  /** `schema.table`, `public` when the source names no schema. */
  readonly table: string;
  /**
   * The user id column, with `through` when it references the table that holds
   * the user id.
   */
  readonly user:
    | SupabaseManifestColumn
    | (SupabaseManifestColumn & { readonly through: SupabaseManifestThrough });
  /**
   * A column for `tableMembershipSource`, the fixed scope for
   * `junctionMembershipSource`.
   */
  readonly scope: SupabaseManifestValue;
  readonly id: SupabaseManifestColumn;
  /**
   * A role column, the fixed roles every row holds, or several role columns
   * whose keys the row holds together.
   */
  readonly role: SupabaseManifestRole | readonly SupabaseManifestRole[];
  /**
   * A `jsonb` column of ancestor ids keyed by scope, or one column per ancestor
   * scope.
   */
  readonly within?:
    | SupabaseManifestColumn
    | { readonly columns: Readonly<Record<string, string>> };
  readonly via?: SupabaseManifestValue;
  readonly expiresAt?: SupabaseManifestColumn;
  readonly disabledAt?: SupabaseManifestColumn;
  /** The columns of `table` that decide the membership. */
  readonly columns: readonly string[];
};

export type SupabaseManifestHelper = {
  readonly name: string;
  /** The argument list, `p_grant text`, or `''` for none. */
  readonly args: string;
  readonly returns: string;
  /**
   * The roles granted `execute`; a field view `anon` reads adds `anon` to the
   * `authenticated` ones.
   */
  readonly execute: readonly string[];
};

/**
 * A table whose row says whether a user or a scope instance is active
 * (`rls.suspension`); a missing row counts as suspended.
 */
export type SupabaseManifestActiveRow = {
  /** `schema.table`. */
  readonly table: string;
  /** The column holding the user id or the scope instance id. */
  readonly id: string;
  /** A nullable timestamp column; a row with a value is suspended. */
  readonly disabledAt?: string;
  /** A status column; only a row whose value is in `active` is active. */
  readonly status?: string;
  readonly active?: readonly string[];
  /**
   * A scope only: the permission keys members of a suspended instance still
   * hold.
   */
  readonly keep?: readonly string[];
};

export type SupabaseManifestRls = {
  readonly schema: string;
  /**
   * Where the helpers read roles and memberships: the claims (`jwt`) or the
   * tables (`database`).
   */
  readonly mode: "jwt" | "database";
  readonly tenantClaim: string;
  /** The declared scopes, root first, with the Postgres type of their ids. */
  readonly scopes: readonly {
    readonly name: string;
    readonly type: string;
    readonly within?: string;
  }[];
  /**
   * Every function `rls generate` writes for policies and trusted SQL to call:
   * `permdock_has`, `permitted_<scope>_ids`, `member_<scope>_ids` and
   * `permdock_user_id`, the caller's user id; in `database` mode
   * `permdock_has_for`, `permitted_<scope>_ids_for` and
   * `member_<scope>_ids_for`; and when a role declares `assigns`,
   * `permdock_can_assign`, `permdock_can_assign_any` and, with custom roles,
   * `permdock_can_assign_custom_role`, each with its `_for` form where one is
   * written. A helper whose `execute` is empty is for trusted SQL only.
   */
  readonly helpers: readonly SupabaseManifestHelper[];
  /**
   * The tables `member_<scope>_ids_for` reads: an `rls.memberships` table
   * mapped for the scope, else `rls.membershipSources`, else the hook's
   * `memberships`.
   */
  readonly memberships: readonly SupabaseManifestMembership[];
  /**
   * Whether custom roles live in the helpers' tables (`rls.customRoles` in
   * `database` mode).
   */
  readonly customRoles?: boolean;
  /** The global-roles table the hook and the `database` mode helpers read. */
  readonly roles?: {
    readonly table: string;
    readonly user: SupabaseManifestColumn;
    readonly role: SupabaseManifestRole | readonly SupabaseManifestRole[];
  };
  /**
   * `rls.suspension`: a suspended user, or a suspended scope instance, holds
   * nothing but its scope's `keep`.
   */
  readonly suspension?: {
    readonly users?: SupabaseManifestActiveRow;
    readonly scopes?: Readonly<Record<string, SupabaseManifestActiveRow>>;
    readonly memberships?: { readonly keep: readonly string[] };
  };
  /**
   * `rls.assignments`: the tables whose client writes the assignment triggers
   * check against `permdock_can_assign_any`, so SQL writing rows there needs no
   * role-ceiling check of its own.
   */
  readonly assignments?: { readonly tables: readonly string[] };
  /**
   * `rls.tokenScopes`: the helpers narrow a delegated token by its `scope`
   * claim through `permdock_token_scope_allows`.
   */
  readonly tokenScopes?: boolean;
  readonly apiKeys?: {
    readonly claim: string;
    readonly scopes: string;
    readonly tenant: string;
    readonly roles: string;
    readonly serviceRoles: readonly string[];
  };
};

/**
 * The manifest of a project in `rls.authorize: 'database'` mode without
 * `supabase.hook`: no token hook, so no `hook`, `budget`, `claims`,
 * `authzVersion` or hook `memberships`.
 */
export type SupabaseDatabaseManifest = Omit<
  SupabaseHookManifest,
  | "authzVersion"
  | "authzVersionBump"
  | "budget"
  | "claims"
  | "hook"
  | "managementApi"
  | "memberships"
>;

/**
 * What `parseSupabaseManifest` returns: a manifest with or without the token
 * hook.
 */
export type SupabaseManifest = SupabaseDatabaseManifest | SupabaseHookManifest;

/** Whether the manifest describes a token hook. */
export function hasTokenHook(
  manifest: SupabaseManifest,
): manifest is SupabaseHookManifest {
  return "hook" in manifest;
}

/**
 * Reads a `permdock.manifest.json` document (parsed, or the JSON text) and
 * validates it against `schemas/supabase-manifest-v1.json`. Returns a
 * deep-frozen copy built from own keys; throws `PermDockValidationError` with
 * every issue, so a manifest of another major is refused.
 */
export function parseSupabaseManifest(json: unknown): SupabaseManifest {
  const issues: StandardSchemaV1.Issue[] = [];
  let input = json;
  if (typeof json === "string") {
    try {
      input = JSON.parse(json);
    } catch (error) {
      invalidManifest([
        {
          message: `Expected JSON text: ${error instanceof Error ? error.message : String(error)}`,
          path: [],
        },
      ]);
    }
  }
  const copy = copyJson(input, [], issues, new Set());
  if (issues.length === 0) {
    checkSchema(supabaseManifestSchema, copy, [], issues);
  }
  if (issues.length > 0) {
    invalidManifest(issues);
  }
  // SAFETY: copy is plain JSON that passed supabaseManifestSchema, the schema SupabaseManifest describes.
  return freezeDeep(copy as SupabaseManifest);
}

function invalidManifest(issues: readonly StandardSchemaV1.Issue[]): never {
  const [first] = issues;
  const where =
    first?.path === undefined || first.path.length === 0
      ? ""
      : ` at ${first.path.map(String).join(".")}`;
  const more =
    issues.length > 1 ? ` (and ${String(issues.length - 1)} more)` : "";
  throw new PermDockValidationError({
    code: "invalid-data",
    permission: "",
    resource: "",
    boundary: "supabase-manifest",
    issues,
    message: `PermDock: invalid Supabase manifest${where}: ${first?.message ?? "unknown"}${more}`,
  });
}
