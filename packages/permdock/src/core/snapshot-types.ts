import type { Condition } from "../conditions/ast.ts";
import type { AppObligation } from "./decision.ts";
import type { Grantee } from "./grantee.ts";
import type { Permission } from "./permission-types.ts";
import type {
  ApprovalRequirement,
  GrantMeta,
  WireValidity,
} from "./policy-types.ts";
import type { Membership } from "./subject.ts";
import type { Plan, Role } from "./vocabulary.ts";
import type { WireDelegation } from "./wire-delegation.ts";

export type Snapshot = {
  readonly v: 1;
  /**
   * RFC 3339. The epoch for a snapshot built without a clock. Signed, it is the
   * token's `iat`.
   */
  readonly issuedAt: string;
  readonly subject: {
    readonly principal: {
      readonly id: string;
      readonly roles: readonly string[];
      readonly plans?: readonly string[];
      readonly tenant?: string;
      readonly memberships?: readonly Membership[];
    } | null;
    /**
     * OAuth `scope` and RFC 9396 `authorization_details`, as the token carried
     * them.
     */
    readonly delegation?: WireDelegation;
    readonly context: Readonly<Record<string, unknown>>;
  };
  /** Roles held in the active tenant, in rank order. */
  readonly roles: readonly string[];
  /**
   * The distinct `meta.audience` values of `roles`, in rank order; absent when
   * none has one.
   */
  readonly audiences?: readonly string[];
  readonly grants: readonly SnapshotGrant[];
  readonly tenants: readonly string[];
  readonly include?: readonly string[];
  readonly simulated?: true;
  /** RFC 3339. Signed, it is the token's `exp`. */
  readonly expiresAt?: string;
  readonly vocabulary?: {
    readonly roles?: Readonly<Record<string, Role>>;
    readonly plans?: Readonly<Record<string, Plan>>;
  };
  /**
   * The policy's scopes in order, so a client checks the row against each
   * membership's instance.
   */
  readonly scopes?: readonly SnapshotScope[];
  /**
   * One entry per tenant in `tenants`: what the subject may hand out there.
   * Absent without tenants.
   */
  readonly assignable?: readonly SnapshotAssignable[];
  /**
   * Allow grants of held roles that only a plan the subject lacks keeps from
   * applying; they grant nothing and name the plan a denial asks for.
   */
  readonly notEntitled?: readonly SnapshotNotEntitled[];
  /**
   * The row id field per resource whose `id` option is not `id`, for the grants
   * in `grants`. Absent when every one reads `id`.
   */
  readonly ids?: Readonly<Record<string, string>>;
  /**
   * The permission keys the policy's delegations let the actor use for the
   * principal, sorted; present only when one applies. Outside it a check is
   * `not-delegated`; inside it a token delegation, when there is one, must
   * still cover.
   */
  readonly delegated?: readonly string[];
  /**
   * The token's authorization version (`authz_ver`) the snapshot was built
   * from. A client compares it with the version in a refresh signal.
   */
  readonly authzVersion?: number;
  /** The Auth session (`session_id`) the snapshot was built for. */
  readonly sessionId?: string;
};

/**
 * A grant the subject would hold on another plan: its permission, role and
 * `to`.
 */
export type SnapshotNotEntitled = {
  readonly permission: string;
  readonly role: string | null;
  readonly to: Grantee | readonly Grantee[];
};

/** One declared scope as a snapshot carries it. */
export type SnapshotScope = {
  readonly name: string;
  readonly key: string;
  readonly within?: string;
  /**
   * Resources whose rows this scope's key partitions, from their `memberOf`
   * relations.
   */
  readonly resources?: readonly string[];
  /**
   * Resource name to the field holding this scope's id, for a resource whose
   * field is not `key` (its own `id`).
   */
  readonly fields?: Readonly<Record<string, string>>;
};

/**
 * The declared roles and the custom-role ceiling the subject may assign in one
 * tenant.
 */
export type SnapshotAssignable = {
  readonly tenant: string;
  readonly roles: readonly string[];
  readonly permissions: readonly Permission[];
  /**
   * Permission key to the levels the subject may hand out; only permissions
   * whose resource declares levels.
   */
  readonly levels?: Readonly<Record<string, readonly string[]>>;
};

export type SnapshotGrant = {
  readonly permission: string;
  readonly effect: "allow" | "deny";
  readonly role: string | null;
  readonly to: Grantee | readonly Grantee[];
  readonly where?: Condition;
  readonly check?: Condition;
  readonly approval?: "human" | ApprovalRequirement;
  /** A scope name or one resource; absent for a global grant. */
  readonly scope?: string | { readonly resource: string };
  readonly membership?: Membership;
  readonly portable?: false;
  readonly fields?: readonly string[];
  /**
   * When the grant applies (RFC 3339, `from` inclusive, `until` exclusive);
   * absent means always.
   */
  readonly validity?: WireValidity;
  /** The grant's declared `name`. */
  readonly name?: string;
  /** The grant's declared `meta`; visible to the client that holds the snapshot. */
  readonly meta?: GrantMeta;
  /** The app obligations an allow declares, emitted on a granted decision. */
  readonly obligations?: readonly AppObligation[];
};

/**
 * What a policy grants, as JSON a client builds snapshots from without the
 * policy: `localSnapshotManifest(policy)` writes it, `localSnapshot` in
 * `permdock/react-native` reads it.
 */
export type LocalSnapshotManifest = {
  readonly v: 1;
  readonly scopes?: readonly SnapshotScope[];
  readonly vocabulary?: Snapshot["vocabulary"];
  /** Declared role names; a custom role cannot take one. */
  readonly roles: readonly string[];
  /** Declared role names in rank order, when an `assigns` graph ranks them. */
  readonly rank?: readonly string[];
  /** Every declared grant, without a membership. */
  readonly grants: readonly SnapshotGrant[];
  /**
   * Per custom-role scope (`global` for platform roles): the grants each entry
   * resolves to.
   */
  readonly custom: Readonly<Record<string, LocalCustomRoleTable>>;
  /**
   * The synced tables a device reads the user's memberships, roles and custom
   * roles from; `permdock powersync generate` adds it.
   */
  readonly rows?: LocalSnapshotRows;
  /**
   * What a device needs to compute `Snapshot.assignable` for the active tenant
   * the way `assignableIn` does on the server.
   */
  readonly assignable?: LocalAssignable;
};

/**
 * The hand-out rules of a policy, as a device evaluates them over its synced
 * memberships and custom roles.
 */
export type LocalAssignable = {
  /**
   * Declared roles a tenant admin may hand out or compose, in rank order, with
   * the scope each sits on and its allow keys.
   */
  readonly roles: readonly {
    readonly name: string;
    readonly on: string;
    readonly allows: readonly string[];
  }[];
  /** Declared role names and permission keys with `meta.manageRoles: true`. */
  readonly manage: {
    readonly roles: readonly string[];
    readonly permissions: readonly string[];
  };
  /**
   * Declared role name to the roles it assigns, when any role declares
   * `assigns`.
   */
  readonly assigns?: Readonly<Record<string, readonly string[]>>;
  /** The first scope's custom-role ceiling, in declaration order. */
  readonly permissions: readonly Permission[];
  /** Permission key to its level names, in declaration order. */
  readonly levels?: Readonly<Record<string, readonly string[]>>;
  /** Index of an allow in `grants` to the levels a holder of it may hand out. */
  readonly grants?: Readonly<Record<string, readonly string[]>>;
};

/** A column of a synced table, or a value every row has. */
export type LocalRowValue =
  | { readonly column: string }
  | { readonly value: string };

/**
 * A column that holds a role key or user id: the value itself, the `column` of
 * the synced `through` table whose `id` it references, or a value each maps to
 * a role key (`null` for no role).
 */
export type LocalRowColumn =
  | { readonly column: string }
  | {
      readonly column: string;
      readonly through: {
        readonly table: string;
        readonly id: string;
        readonly column: string;
      };
    }
  | {
      readonly column: string;
      readonly map: Readonly<Record<string, string | null>>;
    };

/** One synced membership table. Table names are the device's table names. */
export type LocalMembershipRows = {
  readonly table: string;
  readonly user: LocalRowColumn;
  readonly scope: LocalRowValue;
  readonly id: string;
  /**
   * The role columns (the row holds every non-null key), or the fixed roles
   * every row holds.
   */
  readonly roles:
    | readonly LocalRowColumn[]
    | { readonly value: readonly string[] };
  readonly via?: LocalRowValue;
  /** A row with a value in one of these columns is no membership on the device. */
  readonly expiresAt?: string;
  readonly disabledAt?: string;
};

export type LocalSnapshotRows = {
  readonly memberships: readonly LocalMembershipRows[];
  /** The global roles table: one row per user and role. */
  readonly roles?: {
    readonly table: string;
    readonly user: string;
    /** The role columns; the row holds every non-null key. */
    readonly roles: readonly LocalRowColumn[];
  };
  /**
   * The custom-role tables (`tenant_id`, `scope`, `scope_id`, `role`, and
   * `permission`, `effect`, `level` or `include_role`).
   */
  readonly customRoles?: {
    readonly permissions: string;
    readonly includes: string;
  };
};

/**
 * Grants a custom role entry resolves to, held by a placeholder role the client
 * renames.
 */
export type LocalCustomRoleTable = {
  /**
   * `{ permission }` per permission key, and `{ permission, level }` per
   * declared level.
   */
  readonly permissions: Readonly<
    Record<
      string,
      {
        readonly all: readonly SnapshotGrant[];
        readonly levels?: Readonly<Record<string, readonly SnapshotGrant[]>>;
        /** The levels a holder of `all` may hand out. */
        readonly reach?: readonly string[];
        /** Level to the levels a holder of `levels[level]` may hand out. */
        readonly levelReach?: Readonly<Record<string, readonly string[]>>;
      }
    >
  >;
  /** `includes: [role]` per declared role. */
  readonly includes: Readonly<Record<string, readonly SnapshotGrant[]>>;
  /**
   * Declared role to permission key to the levels a holder of its included
   * grants may hand out.
   */
  readonly includeReach?: Readonly<
    Record<string, Readonly<Record<string, readonly string[]>>>
  >;
};
