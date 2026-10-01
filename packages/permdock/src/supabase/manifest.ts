/**
 * What `permdock supabase inspect --json` prints: the contract between the
 * generated hook and SQL helpers and a package that writes policies or claims
 * next to them (better-supabase). `version` is the major of this shape.
 */
export type SupabaseHookManifest = {
  readonly version: 1;
  readonly hook: {
    readonly schema: string;
    readonly function: 'custom_access_token_hook';
    readonly out: string;
  };
  readonly helpers: {
    readonly schema: string;
    /**
     * `permdock_has` and, per declared scope, `permitted_<scope>_ids`, each
     * `(p_grant text)`, and the membership-only `member_<scope>_ids()`.
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
};

export type SupabaseHookClaim = {
  readonly name: string;
  /** `permdock`, or the `<schema>.<function>` of a `supabase.hook.claims` entry. */
  readonly source: string;
  /** Whether the claim counts toward `budget.bytes`. */
  readonly budget: boolean;
};
