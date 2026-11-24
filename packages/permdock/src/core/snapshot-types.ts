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

/**
 * The tenants a snapshot lists: `'all'` for every tenant the subject belongs
 * to, or the named tenants among them. A name with no membership is dropped.
 */
export type SnapshotTenants = "all" | readonly string[];

/**
 * The flat form the evaluator reads: one entry per grant, each with its full
 * terms and membership. `readSnapshot` returns it.
 */
export type ExpandedSnapshot = {
  readonly v: 2;
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
  /**
   * Set by a local snapshot. Assignable permissions from it are `server-only`:
   * the device list is a hint and the server decides what may be handed out.
   */
  readonly local?: true;
  /** The Auth session (`session_id`) the snapshot was built for. */
  readonly sessionId?: string;
  /**
   * What a check with no row, team or field answers in the active tenant, so a
   * client renders `usePermission(permission)` without loading its evaluator.
   * Every key not listed is denied. Absent when an answer depends on the clock
   * (a grant `validity`, a membership `expiresAt`) or on the server alone.
   */
  readonly typeLevel?: SnapshotTypeLevel;
  /**
   * Tenants whose grants `maxGrantsPerTenant` left out. A check in one denies
   * with `opaque-condition`, so a client asks the server.
   */
  readonly truncated?: readonly string[];
  /**
   * Per key a grant's `requires` names, where the subject holds it: `true`
   * globally, else the `subject.principal.memberships` indexes.
   */
  readonly requires?: Readonly<Record<string, true | readonly number[]>>;
};

/**
 * A grant's `requires` keys and the `[scope, field]` pairs its placed condition
 * filters, in partition order.
 */
export type SnapshotRequires = {
  readonly keys: readonly string[];
  readonly fields: readonly (readonly [scope: string, field: string])[];
};

/**
 * What a grant says apart from its permission key: its effect, role, grantee,
 * conditions, scope and membership. A `Snapshot` lists each distinct set once
 * in `conditions`.
 */
export type SnapshotGrantTerms = Omit<SnapshotGrant, "permission">;

/**
 * Grant terms as the wire writes them: `where` without the condition its
 * `requires` table places, unless `placed` marks it as already holding it.
 */
export type SnapshotWireTerms = SnapshotGrantTerms & { readonly placed?: true };

/**
 * One grant reference in a wire snapshot: a `conditions` index, or a
 * `conditions` index with the `subject.principal.memberships` indexes the grant
 * holds through, one grant per membership in order.
 */
export type SnapshotGrantRef =
  | number
  | readonly [term: number, memberships: number | readonly number[]];

/**
 * An `in` or `notIn` value the wire form keeps in `lists`, by index; equal id
 * lists are written once.
 */
export type SnapshotListRef = { readonly list: number };

/** `assignable` as the wire form writes it: permissions index `permissions`. */
export type SnapshotWireAssignable = Omit<SnapshotAssignable, "permissions"> & {
  readonly permissions: readonly number[];
};

/**
 * The wire form `snapshot()` returns and every client takes, version 2.
 * `conditions` holds each distinct set of grant terms once, without the
 * membership; a grant is `{ permission, cond }` and each `cond` reference names
 * its terms and the memberships it holds through. `parseSnapshot` validates it;
 * `readSnapshot` expands it into the flat form the evaluator reads.
 */
export type Snapshot = Omit<
  ExpandedSnapshot,
  "v" | "subject" | "grants" | "assignable" | "typeLevel" | "requires"
> & {
  readonly v: 2;
  readonly subject: Omit<ExpandedSnapshot["subject"], "principal"> & {
    readonly principal:
      | (Omit<
          NonNullable<ExpandedSnapshot["subject"]["principal"]>,
          "memberships"
        > & { readonly memberships?: readonly SnapshotWireMembership[] })
      | null;
  };
  /** The membership shapes `[shape, id]` entries index. */
  readonly shapes?: readonly SnapshotMembershipShape[];
  /** As in the flat form, or, against a bundle, bit sets over its `keys`. */
  readonly typeLevel?: SnapshotTypeLevel | SnapshotWireTypeLevel;
  /**
   * Per group of keys with the same holding, the membership indexes where the
   * subject holds them, or `true` for a global hold. A term's `requires`
   * condition is placed from it.
   */
  readonly requires?: readonly (readonly [
    keys: readonly string[],
    held: true | readonly number[],
  ])[];
  /**
   * The `digest` of the `ClientBundle` the snapshot leaves its vocabulary,
   * scopes or key table to. A reader with another bundle refuses it.
   */
  readonly bundle?: string;
  readonly conditions: readonly SnapshotWireTerms[];
  /** The id lists `{ list: n }` in a condition's `in` value refers to. */
  readonly lists?: readonly (readonly string[])[];
  /**
   * Grants the snapshot leaves to a `ClientBundle`, built with `omitStatic`.
   * Absent when every grant is inline.
   */
  readonly static?: SnapshotStatic;
  readonly grants: readonly {
    readonly permission: string;
    /**
     * A `conditions` index, or the references of consecutive grants of one
     * permission in grant order.
     */
    readonly cond: number | readonly SnapshotGrantRef[];
  }[];
  /** Every permission an `assignable` entry lists, written once. */
  readonly permissions?: readonly Permission[];
  readonly assignable?: readonly SnapshotWireAssignable[];
};

/** The scope, roles and `via` memberships share; written once per snapshot. */
export type SnapshotMembershipShape = {
  readonly scope: string;
  readonly roles: readonly string[];
  readonly via?: Membership["via"];
};

/**
 * A membership on the wire: `[shape, id]`, or the whole membership when it
 * carries more than a shape holds.
 */
export type SnapshotWireMembership =
  | readonly [shape: number, id: string]
  | Membership;

/** `typeLevel` as bit sets over the bundle's `keys`. */
export type SnapshotWireTypeLevel = {
  readonly bits: true;
  readonly granted: string;
  readonly approval?: string;
  readonly endpoint?: string;
};

/**
 * The role grants a snapshot refers to instead of carrying. `held` lists one
 * `[role, membership]` per group: the role's bundle grants with that entry of
 * `subject.principal.memberships` attached, or none for a global role.
 * `digests` pins the bundle each role was checked against; a client whose
 * bundle differs resolves nothing for that role.
 */
export type SnapshotStatic = {
  readonly held: readonly (readonly [string, number | null])[];
  readonly digests: Readonly<Record<string, string>>;
  /**
   * The digest of the bundle's `shared` grants, when the subject's grants
   * without a role are exactly those.
   */
  readonly shared?: string;
};

/**
 * The static grants of declared roles, written once per policy by
 * `clientBundle(policy)` and shipped as a cached script instead of in every
 * snapshot. A role's grants are what a holder of only that role receives.
 */
export type ClientBundle = {
  readonly v: 2;
  readonly conditions: readonly SnapshotWireTerms[];
  /** The policy's vocabulary; a snapshot built against the bundle omits it. */
  readonly vocabulary?: ExpandedSnapshot["vocabulary"];
  /** The policy's scopes; a snapshot built against the bundle omits them. */
  readonly scopes?: ExpandedSnapshot["scopes"];
  /** Every permission key of the policy, sorted: the table bit sets index. */
  readonly keys: readonly string[];
  /** Pins `vocabulary`, `scopes` and `keys`; a snapshot names it in `bundle`. */
  readonly digest: string;
  /**
   * The grants every signed-in subject holds without a role, as a probe
   * principal with no role or membership receives them.
   */
  readonly shared?: {
    readonly digest: string;
    readonly grants: ClientBundle["roles"][string]["grants"];
  };
  readonly roles: Readonly<
    Record<
      string,
      {
        readonly digest: string;
        readonly grants: readonly {
          readonly permission: string;
          readonly cond: number | readonly number[];
        }[];
      }
    >
  >;
};

/** The permission keys a rowless check grants or sends to an approver. */
export type SnapshotTypeLevel = {
  readonly granted: readonly string[];
  readonly approval?: readonly string[];
  /** Keys whose rowless answer needs the evaluations endpoint. */
  readonly endpoint?: readonly string[];
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
  /**
   * The grant's `requires`: `where` ends with the condition placed from where
   * the subject holds each key (`ExpandedSnapshot.requires`).
   */
  readonly requires?: SnapshotRequires;
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
  readonly vocabulary?: ExpandedSnapshot["vocabulary"];
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
 * a role key (`null` for no role). A composite reference lists every pair in
 * `on` (row column to `through` column); a `through` row matches only when all
 * of them do, and the row holds the value of every match.
 */
export type LocalRowColumn =
  | { readonly column: string }
  | {
      readonly column: string;
      readonly through: {
        readonly table: string;
        readonly id: string;
        readonly column: string;
        readonly on?: Readonly<Record<string, string>>;
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
  /**
   * The user's authorization version row (`permdock_authz_version`), the value
   * the token hook stamps `authz_ver` from.
   */
  readonly version?: {
    readonly table: string;
    readonly user: string;
    readonly version: string;
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
