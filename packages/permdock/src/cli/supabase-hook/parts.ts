import type { Scope } from "../../core/scopes.ts";
import type {
  SupabaseManifestActiveFrom,
  SupabaseManifestMembership,
} from "../../supabase/manifest.ts";
import type { SqlMembershipSource } from "../../supabase/sources.ts";
import type { RoleRows } from "../sql/global-roles.ts";
import type {
  RlsActiveRow,
  RlsSuspendedScope,
  SupabaseHookConfig,
} from "../types.ts";
import type { AttrsPlan, ExtraClaim } from "./claims.ts";
import type { activeFromSql } from "./memberships.ts";

export type Parts = {
  readonly schema: string;
  readonly scopes: readonly Scope[];
  readonly root: string;
  readonly sources: readonly SqlMembershipSource[];
  readonly budget: number;
  readonly version: boolean;
  /**
   * The hook reuses the incoming claims on a token refresh whose `authz_ver` is
   * current.
   */
  readonly refreshReuse: boolean;
  /** `'slim'` skips every read for a token with a `client_id`. */
  readonly oauth: "full" | "slim";
  /** The version bump broadcast; `undefined` sends nothing. */
  readonly broadcast:
    | { readonly topic: string; readonly receivePolicy: boolean }
    | undefined;
  readonly jwtExpiry: number;
  readonly tenantClaim: string;
  /**
   * Set when custom roles live in the `permdock` tables; the type of the first
   * scope's id.
   */
  readonly customRoles: { readonly tenantType: string } | undefined;
  readonly users: RlsActiveRow | undefined;
  /** `rls.suspension.scopes.<root>`: the active-row table of the tenants. */
  readonly tenants: RlsSuspendedScope | undefined;
  /** The Postgres type of the root scope's ids. */
  readonly tenantType: string;
  readonly hook: SupabaseHookConfig;
  /** Global roles for `user_role` and `roles`; `undefined` with `roles: false`. */
  readonly roles: RoleRows | undefined;
  readonly active: ReturnType<typeof activeFromSql>;
  readonly activeFrom: SupabaseManifestActiveFrom;
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
