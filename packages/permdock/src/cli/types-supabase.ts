import type { SqlMembershipSource } from "../supabase/sources.ts";
import type { GlobalRoles } from "./types-rls-roles.ts";
import type { RlsSuspension } from "./types-rls.ts";

/** `permdock supabase hook generate` input. */
export type SupabaseHookConfig = {
  /**
   * The same `tableMembershipSource` / `junctionMembershipSource` sources the
   * app passes as `memberships`. Default: one junction source per
   * `rls.memberships` scope table.
   */
  readonly memberships?: readonly SqlMembershipSource[];
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
   * first) through `member_team_ids_for`. Teams share the `budget` with the
   * roles, the attrs, the version and the kept memberships. On overflow
   * `team_ids` is omitted and `team_ids_truncated` is set; the claim is never a
   * prefix, and `memberships_truncated` is not set by team rows. A suspended
   * user gets none, a row with `disabledAt` set counts as no team, and with
   * `tenant` a suspended tenant's teams are left out. Clients must not write
   * the table.
   */
  readonly teams?: {
    readonly table: string;
    readonly user: string;
    readonly team: string;
    readonly tenant?: string;
    readonly disabledAt?: string;
  };
  readonly before?: string | readonly string[];
  /**
   * Check the claims the hook wrote against `supabase-claims-v1.json` with
   * pg_jsonschema, and drop them all on a mismatch so the user signs in with no
   * PermDock access instead of an error. Needs the extension. Default `false`.
   */
  readonly validate?: boolean;
  /**
   * How the hook answers `authentication_method: 'token_refresh'`. `'reuse'`
   * (default) keeps the roles, memberships and team ids of the incoming claims
   * when they carry an `authz_ver` equal to the current version and no
   * truncation flag, and otherwise reads everything again. Sources with
   * `expiresAt` or a scope suspension, and `version: false`, always read again;
   * an explicit `'reuse'` with one of them fails the command. `'full'` always
   * reads.
   */
  readonly refresh?: "reuse" | "full";
  /**
   * The claim shape for a token with a `client_id` (an OAuth client). `'full'`
   * (default) writes the same claims as a user session. `'slim'` writes empty
   * `roles` and `memberships` and no `attrs`, `team_ids`, tenant claim,
   * `authz_ver` or `hook.claims`, and skips every read.
   */
  readonly oauth?: "full" | "slim";
  /**
   * Bytes of JSON the `memberships` claim may use. Default
   * `supabaseMembershipsBudget` (1024).
   */
  readonly budget?: number;
  /**
   * `false` writes `memberships` as `[]`, and sets `memberships_truncated` when
   * the user holds a membership, so a reader takes the subject from the
   * database (`permdock_subject()`, `subject_for`, a `claimsFirst` source). The
   * tenant claim and `team_ids` are written as before, and no refresh reuses
   * the incoming claims. `database` mode only: in `jwt` mode the RLS helpers
   * read the claim, so `generate` refuses it. Default `true`.
   */
  readonly membershipsClaim?: boolean;
  /**
   * Keep `permdock_authz_version` and write the `authz_ver` claim. Default
   * `true`.
   */
  readonly version?: boolean;
  /**
   * Broadcast every version bump as `{ user_id, version }` with event `changed`
   * on `topic`, which no user may join, and on the user's own `authz:<uid>`.
   * `topic` defaults to `better_supabase:authz` in a better-supabase project,
   * else `permdock:authz`. `receivePolicy` writes the `realtime.messages`
   * policy that lets a user receive `authz:<uid>`; it defaults to `true`, and
   * to `false` when better-supabase's `sessions.authzVersions` writes the same
   * policy. `false` sends nothing.
   */
  readonly broadcast?:
    | false
    | { readonly topic?: string; readonly receivePolicy?: boolean };
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
  /**
   * Whose rights the hook reads with. `'invoker'` (default) runs as
   * `supabase_auth_admin`, so the hook grants it `select` and a read policy on
   * every table it reads. `'definer'` runs as the owner of the migration
   * (`postgres` on Supabase) and grants `supabase_auth_admin` only `execute`;
   * the owner must be able to read every table. `permdock doctor
   * --db-url-stdin` runs the hook as `supabase_auth_admin` either way (PD085).
   */
  readonly security?: "invoker" | "definer";
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
