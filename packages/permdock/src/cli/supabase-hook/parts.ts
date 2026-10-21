import type { Scope } from "../../core/scopes.ts";
import type { SupabaseManifestMembership } from "../../supabase/manifest.ts";
import type { SqlMembershipSource } from "../../supabase/sources.ts";
import type { RoleRows } from "../sql/global-roles.ts";
import type { RlsActiveRow, SupabaseHookConfig } from "../types.ts";
import type { AttrsPlan, ExtraClaim } from "./claims.ts";
import type { activeFromSql } from "./memberships.ts";

export type Parts = {
  readonly schema: string;
  readonly scopes: readonly Scope[];
  readonly root: string;
  readonly sources: readonly SqlMembershipSource[];
  readonly budget: number;
  readonly version: boolean;
  readonly jwtExpiry: number;
  readonly tenantClaim: string;
  readonly users: RlsActiveRow | undefined;
  readonly hook: SupabaseHookConfig;
  /** Global roles for `user_role` and `roles`; `undefined` with `roles: false`. */
  readonly roles: RoleRows | undefined;
  readonly active: ReturnType<typeof activeFromSql>;
  readonly attrs: AttrsPlan | undefined;
  readonly extra: readonly ExtraClaim[];
  readonly before: readonly string[];
  /**
   * The `rls.schema` helpers, and the scopes `rls generate` emits
   * `member_<scope>_ids_for` for.
   */
  readonly helpers: {
    readonly schema: string;
    readonly memberFor: readonly string[];
    /**
     * The scopes `rls generate` emits `permitted_<scope>_users` for in
     * `database` mode.
     */
    readonly holders: readonly string[];
    /** The sources `member_<scope>_ids_for` reads, deduplicated across scopes. */
    readonly memberships: readonly SupabaseManifestMembership[];
  };
};
