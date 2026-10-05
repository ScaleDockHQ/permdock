import type { StandardSchemaV1 } from "@standard-schema/spec";

import type { ClientNames } from "../core/clients.ts";
import type { AuthEvent } from "../core/interfaces.ts";
import type { Principal } from "../core/subject.ts";
import type { SupabaseActClaim } from "./claims.ts";

export type SupabasePrincipal = Principal & {
  readonly claims?: Readonly<Record<string, unknown>>;
  readonly email?: string;
  readonly phone?: string;
  readonly is_anonymous?: boolean;
};

export type SupabaseInclude = "email" | "phone" | "is_anonymous";

/**
 * A column that holds a foreign key: the value is `column` of `through`,
 * joined on `on`. A role reads its key from a roles table
 * (`{ through: 'roles', on: { role_id: 'id' }, column: 'key' }`); a
 * membership source's user can read its user id from a profile table
 * (`{ through: 'contact_profiles', on: { contact_profile_id: 'id' }, column: 'user_id' }`).
 */
export type RoleThrough = {
  /** The referenced table; unqualified, it is in the schema of the table that references it. */
  readonly through: string;
  /** One entry: the referencing column to the column of `through` it references. */
  readonly on: Readonly<Record<string, string>>;
  /** The column of `through` that holds the value: the role key, or the user id. */
  readonly column: string;
};

export type SupabaseMembershipTable = {
  readonly table: string;
  readonly user: string;
  /**
   * The role key column, a reference to a roles table that holds the key, or
   * several of them: the row holds every non-null key.
   */
  readonly role: string | RoleThrough | readonly (string | RoleThrough)[];
  /** Per scope name, the column holding that scope's id: the table's own scope and its ancestors. */
  readonly columns?: Readonly<Record<string, string>>;
  readonly tenant?: string;
  readonly team?: string;
  readonly id?: string;
  readonly expiresAt?: string;
};

/** A table whose row says whether a user or a scope instance is active. A missing row counts as suspended. */
export type SupabaseActiveRow = {
  readonly table: string;
  /** Column holding the user id or the scope instance id. */
  readonly id: string;
  /** Nullable timestamp column; a row with a value is suspended. */
  readonly disabledAt?: string;
  /** Status column; only a row whose value is in `active` counts as active. */
  readonly status?: string;
  readonly active?: readonly string[];
};

export type SupabaseSuspension = {
  /** A suspended user holds no role and no membership. */
  readonly users?: SupabaseActiveRow;
  /** Per scope name: a suspended instance voids its memberships and every membership nested under it. */
  readonly scopes?: Readonly<Record<string, SupabaseActiveRow>>;
};

type SupabaseMemberships = {
  /** The membership table of each named scope. */
  readonly scopes?: Readonly<Record<string, SupabaseMembershipTable>>;
  readonly tenant?: SupabaseMembershipTable;
  readonly team?: SupabaseMembershipTable;
  readonly resource?: Readonly<Record<string, SupabaseMembershipTable>>;
};

export type AuthorizeSqlOptions = {
  /** Postgres schema of `authorize`, `user_roles`, `role_permissions` and `app_permission`. Default `permdock`. */
  readonly schema?: string;
  /** `database` (default) reads the tables on every call; `jwt` reads the hook-injected claims. */
  readonly authorize?: "database" | "jwt";
  /** The policy's first scope, which `requested_tenant` is an instance of. Default `tenant`. */
  readonly scope?: string;
  /** Membership table for tenant requests in `database` mode; without one they deny. */
  readonly tenant?: boolean | SupabaseMembershipTable;
  /**
   * Tenant requests also answer from custom roles, through the `permdock_custom_keys` function
   * `permdock rls generate --custom-roles` emits: the `custom_role_*` tables in `database` mode,
   * the `memberships[].grants` claim in `jwt` mode. `declared` role names never resolve as custom.
   */
  readonly customRoles?: {
    readonly declared: readonly string[];
    /** Stored allows may carry a level (`custom_role_permissions.level`). */
    readonly levels?: true;
  };
  /** A suspended user, or a suspended instance of `scope` for a tenant request, answers `false`. */
  readonly suspension?: SupabaseSuspension;
};

export type SupabaseRlsOptions = {
  readonly roleClaim?: string;
  readonly tenantClaim?: string;
  /** Postgres type of tenant columns; the tenant claim is cast to it. `rls generate` defaults to `uuid`. */
  readonly tenantType?: string;
  readonly memberships?: SupabaseMembershipTable | SupabaseMemberships;
  readonly suspension?: SupabaseSuspension;
};

export type SupabaseRlsConfig = {
  readonly dialect: "supabase";
  readonly roleClaim: string;
  readonly tenantClaim: string;
  readonly tenantType?: string;
  readonly memberships?: SupabaseMemberships;
  readonly suspension?: SupabaseSuspension;
};

/**
 * The structural shape `subjectFromSupabaseSession` reads: a discriminant and the verified JWT claims.
 * Matches better-supabase's `AuthSession` and similar session objects without importing them.
 */
export type SupabaseSessionLike = {
  readonly kind: string;
  readonly claims?: unknown;
};

export type SupabaseSubjectOptions = {
  readonly roles?: string;
  readonly tenant?: string;
  readonly memberships?: string;
  readonly schema?: StandardSchemaV1;
  readonly include?: readonly SupabaseInclude[];
  readonly declared?: readonly string[];
  /** Claim holding plan names per tenant id; the active tenant's entry becomes `principal.plans`. */
  readonly plans?: string;
  /** Names for OAuth client ids: an `oauth-client` actor gets `client` set to the name of its id, which a policy delegation matches with `to: { kind: 'oauth-client', client }`. */
  readonly clients?: ClientNames;
  /** `'deny'` maps a token with `is_anonymous: true` (`signInAnonymously()`) to the anonymous subject, as `rls.anonymousSignIns: 'deny'` does in RLS. */
  readonly anonymousSignIns?: "deny";
  /** Audit hook: `membership-dropped` for a `memberships` entry that could not be read, `invalid-chain` for a malformed `act`. */
  readonly onAuth?: (event: AuthEvent) => void;
};

/**
 * Who acts for the user. `oauth-client`: a third-party app or an agent chain (`client_id`, or an
 * `act` without `kind`). `support`: a support session (`act.kind: "support"` with `session_id`).
 * `impersonation`: an admin acting as the user (`act.kind: "impersonation"`). `chain` is a copy of
 * the token's `act` claim when it has one.
 */
export type SupabaseActor =
  | {
      readonly id: string;
      readonly kind: "oauth-client";
      readonly chain?: SupabaseActClaim;
    }
  | {
      readonly id: string;
      readonly kind: "support";
      readonly sessionId: string;
      readonly readOnly: boolean;
      readonly reason?: string;
      readonly chain: SupabaseActClaim;
    }
  | {
      readonly id: string;
      readonly kind: "impersonation";
      readonly reason?: string;
      readonly chain: SupabaseActClaim;
    };

/** `actorOf` output: `{ ok: false }` must deny. */
export type SupabaseActorResult =
  | { readonly ok: true; readonly actor?: SupabaseActor }
  | { readonly ok: false; readonly reason: "invalid-chain" };

export type SupabaseDelegation = { readonly scopes: readonly string[] };
