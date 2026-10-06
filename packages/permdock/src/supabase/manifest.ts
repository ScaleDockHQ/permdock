/**
 * What `permdock supabase inspect --json` prints and `--out` writes to
 * `permdock.manifest.json`: the contract between the generated hook and SQL
 * helpers and a package that writes policies or claims next to them
 * (better-supabase). `version` is the major of this shape; a field is only
 * ever added within it. `schemas/supabase-manifest-v1.json` is its JSON Schema.
 */
export type SupabaseHookManifest = {
  readonly $schema: "https://permdock.com/schemas/supabase-manifest-v1.json";
  readonly version: 1;
  readonly hook: {
    readonly schema: string;
    readonly function: "custom_access_token_hook";
    readonly out: string;
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
  readonly budget: {
    readonly bytes: number;
    readonly measure: string;
  };
  readonly claims: readonly SupabaseHookClaim[];
  readonly authzVersion: boolean;
  /**
   * With `authzVersion`, the function that bumps the listed users' `authz_ver`,
   * for a membership source outside the hook. It is `security definer` and no
   * client role may execute it: call it from a trigger owned by the table's owner.
   */
  readonly authzVersionBump?: {
    readonly schema: string;
    readonly function: "permdock_bump_authz_version_for";
    readonly args: "p_users uuid[]";
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

/** A column that references another table: the value (role key or user id) is `column` of `table`, matched on `id`. */
export type SupabaseManifestThrough = {
  readonly table: string;
  readonly id: string;
  readonly column: string;
};

/** A role column (with `through` when it references a roles table), or the fixed roles every row holds. */
export type SupabaseManifestRole =
  | SupabaseManifestValue
  | (SupabaseManifestColumn & { readonly through: SupabaseManifestThrough });

/** One `fromTable` or `fromJunction` source. */
export type SupabaseManifestMembership = {
  /** `schema.table`, `public` when the source names no schema. */
  readonly table: string;
  /** The user id column, with `through` when it references the table that holds the user id. */
  readonly user:
    | SupabaseManifestColumn
    | (SupabaseManifestColumn & { readonly through: SupabaseManifestThrough });
  /** A column for `fromTable`, the fixed scope for `fromJunction`. */
  readonly scope: SupabaseManifestValue;
  readonly id: SupabaseManifestColumn;
  /** A role column, the fixed roles every row holds, or several role columns whose keys the row holds together. */
  readonly role: SupabaseManifestRole | readonly SupabaseManifestRole[];
  /** A `jsonb` column of ancestor ids keyed by scope, or one column per ancestor scope. */
  readonly within?:
    | SupabaseManifestColumn
    | { readonly columns: Readonly<Record<string, string>> };
  readonly via?: SupabaseManifestValue;
  readonly expiresAt?: SupabaseManifestColumn;
  /** The columns of `table` that decide the membership. */
  readonly columns: readonly string[];
};

export type SupabaseManifestHelper = {
  readonly name: string;
  /** The argument list, `p_grant text`, or `''` for none. */
  readonly args: string;
  readonly returns: string;
  /** The roles granted `execute`; a field view `anon` reads adds `anon` to the `authenticated` ones. */
  readonly execute: readonly string[];
};

/** A table whose row says whether a user or a scope instance is active (`rls.suspension`); a missing row counts as suspended. */
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
};

export type SupabaseManifestRls = {
  readonly schema: string;
  /** Where the helpers read roles and memberships: the claims (`jwt`) or the tables (`database`). */
  readonly mode: "jwt" | "database";
  readonly tenantClaim: string;
  /** The declared scopes, root first, with the Postgres type of their ids. */
  readonly scopes: readonly {
    readonly name: string;
    readonly type: string;
    readonly within?: string;
  }[];
  /**
   * Every function `rls generate` writes for policies and trusted SQL to
   * call: `permdock_has`, `permitted_<scope>_ids` and `member_<scope>_ids`;
   * in `database` mode `permdock_has_for`, `permitted_<scope>_ids_for` and
   * `member_<scope>_ids_for`; and when a role declares `assigns`,
   * `permdock_can_assign`, `permdock_can_assign_any` and, with custom roles,
   * `permdock_can_assign_custom_role`, each with its `_for` form where one
   * is written. A helper whose `execute` is empty is for trusted SQL only.
   */
  readonly helpers: readonly SupabaseManifestHelper[];
  /**
   * The tables `member_<scope>_ids_for` reads: an `rls.memberships` table
   * mapped for the scope, else `rls.membershipSources`, else the hook's
   * `memberships`.
   */
  readonly memberships: readonly SupabaseManifestMembership[];
  /** Whether custom roles live in the helpers' tables (`rls.customRoles` in `database` mode). */
  readonly customRoles?: boolean;
  /** The global-roles table the hook and the `database` mode helpers read. */
  readonly roles?: {
    readonly table: string;
    readonly user: SupabaseManifestColumn;
    readonly role: SupabaseManifestRole | readonly SupabaseManifestRole[];
  };
  /** `rls.suspension`: a suspended user, or a suspended scope instance, holds nothing. */
  readonly suspension?: {
    readonly users?: SupabaseManifestActiveRow;
    readonly scopes?: Readonly<Record<string, SupabaseManifestActiveRow>>;
  };
  /**
   * `rls.assignments`: the tables whose client writes the assignment
   * triggers check against `permdock_can_assign_any`, so SQL writing rows
   * there needs no role-ceiling check of its own.
   */
  readonly assignments?: { readonly tables: readonly string[] };
};
