import type { AppData } from "./app-data.ts";
import type { ActorKind, MembershipVia } from "./open-union.ts";
import type { RoleMeta } from "./vocabulary.ts";

export type JsonWebKeyLike = {
  readonly kty?: string;
  readonly [key: string]: unknown;
};

export type Binding = {
  readonly jkt?: string;
  readonly "x5t#S256"?: string;
  readonly jwk?: JsonWebKeyLike;
  readonly kid?: string;
};

/**
 * One OpenID Connect for Identity Assurance `verified_claims` entry, kept as
 * the issuer sent it: opaque, frozen evidence for conditions and audit.
 */
export type VerifiedClaims = {
  readonly verification: Readonly<Record<string, unknown>> & {
    readonly trust_framework: string;
  };
  readonly claims: Readonly<Record<string, unknown>>;
};

export type Assurance = {
  readonly acr?: string;
  readonly amr?: readonly string[];
  readonly authTime?: number;
  readonly verified?: readonly VerifiedClaims[];
};

/**
 * Roles held in one scope instance (`scope` + `id`, with the id of every
 * ancestor scope in `within`) or on one resource (`on`). Evaluation only sees
 * the canonical form; `tenant` / `team` are accepted as input for the first and
 * second declared scope and normalised away.
 */
export type Membership = {
  readonly scope?: string;
  readonly id?: string;
  readonly within?: Readonly<Record<string, string>>;
  readonly on?: { readonly resource: string; readonly id: string };
  readonly roles: readonly string[];
  /**
   * Roles the holder may activate here but does not hold; `permdock.activate`
   * writes an elevated membership.
   */
  readonly eligible?: readonly string[];
  readonly via?: MembershipVia;
  readonly expiresAt?: number;
  /**
   * The principal id that wrote this membership: who elevated, consented to or
   * granted the access.
   */
  readonly grantedBy?: string;
  /**
   * Free text recording why the membership was written: the activation or
   * consent justification.
   */
  readonly reason?: string;
  /**
   * A subgroup the holder belongs to inside the instance (`vendor-support`); a
   * `junctionMembershipSource` group column fills it.
   */
  readonly member?: { readonly group: string };
  /**
   * `idp`: the identity provider (SCIM) owns this membership; the application
   * must not edit it.
   */
  readonly managedBy?: "idp";
  /**
   * Seats this membership holds (`dev-mode`, `editor`); `plan()` grantees match
   * them inside the active tenant.
   */
  readonly entitlements?: readonly string[];
  /**
   * Set when the instance or an ancestor instance is suspended: the permission
   * keys the membership still grants (`suspension.scopes.<scope>.keep`). Every
   * other grant, allow or deny, ignores it, and so do role listings.
   */
  readonly keep?: readonly string[];
  /**
   * Data the application owns about this membership (a department, a seat
   * label). Plain JSON from a trusted membership source, checked by
   * `definePolicy(…, { x: { membership } })`. Never read in evaluation,
   * conditions or RLS, and never written into token claims.
   */
  readonly x?: AppData;
  /** Input only: an instance of the first scope. */
  readonly tenant?: string;
  /** Input only: an instance of the second scope, inside `tenant`. */
  readonly team?: string;
};

/**
 * One permission a custom role adds or removes. It names a declared permission
 * key and carries no condition, approval or limit of its own.
 */
export type CustomRoleGrant = {
  readonly permission: string;
  readonly effect?: "allow" | "deny";
  /**
   * A level the permission's resource declares (`resource(…, { levels })`);
   * allows only.
   */
  readonly level?: string;
};

type CustomRoleBody = {
  readonly name: string;
  readonly includes?: readonly string[];
  readonly grants?: readonly CustomRoleGrant[];
  /**
   * Display text and app data, carried onto the role leaf `assignableRoles()`
   * returns. `x` is checked by the role tree's `defineRoles(…, { x })` schema;
   * an invalid `x` is dropped, not the role.
   */
  readonly meta?: RoleMeta;
};

/** A role a tenant defines, held on memberships inside that tenant. */
export type TenantCustomRole = CustomRoleBody & {
  /** The instance of the first scope that owns the role. */
  readonly tenant: string;
  /**
   * The scope the role is held at; defaults to the first scope. Its ceiling is
   * that scope's assignable roles.
   */
  readonly scope?: string;
  /** Pins the role to one instance of `scope`. */
  readonly id?: string;
  /** Input only: `scope` = the second scope, `id` = this team. */
  readonly team?: string;
  readonly shared?: undefined;
};

/**
 * A role the platform defines, held through `principal.roles` like a declared
 * global role. Its ceiling is the allows of the declared global roles marked
 * `assignable`.
 */
export type GlobalCustomRole = CustomRoleBody & {
  readonly scope: "global";
  readonly tenant?: undefined;
  readonly id?: undefined;
  readonly team?: undefined;
  readonly shared?: undefined;
};

/**
 * A role the platform defines once for every tenant, held on memberships of its
 * scope in any tenant. Tenant admins assign it but never edit it. Its ceiling
 * is the assignable declared roles of its scope; its name wins over a tenant
 * custom role of the same name.
 */
export type SharedCustomRole = CustomRoleBody & {
  readonly shared: true;
  /**
   * The scope the role is held at, never `'global'`; defaults to the first
   * scope.
   */
  readonly scope?: string;
  readonly tenant?: undefined;
  readonly id?: undefined;
  readonly team?: undefined;
};

export type CustomRole = TenantCustomRole | SharedCustomRole | GlobalCustomRole;

export type Principal = {
  readonly id: string;
  readonly issuer?: string;
  /**
   * `contact`: an external person (a customer contact, a portal user). Only its
   * `{ on }` memberships count; it never approves, creates keys or publishes,
   * and is read-only unless a role whose `for` lists `contact` grants the
   * write.
   */
  readonly kind?: "user" | "service" | "workload" | "link" | "feed" | "contact";
  readonly roles?: readonly string[];
  readonly plans?: readonly string[];
  readonly memberships?: readonly Membership[];
  /**
   * The token dropped memberships to stay under its size budget; a
   * `claimsFirst` source reads the rest.
   */
  readonly membershipsTruncated?: boolean;
  /** The authorization version the token was minted at (`authz_ver`). */
  readonly authzVersion?: number;
  readonly tenant?: string;
  /**
   * Set by core when a requested tenant is not one the subject holds: the
   * denial is then `no-membership`, not `no-tenant`. Never read from a token.
   */
  readonly unheldTenant?: string;
  readonly assurance?: Assurance;
  readonly binding?: Binding;
  readonly [key: string]: unknown;
};

export type Actor = {
  readonly id: string;
  readonly kind: ActorKind;
  readonly binding?: Binding;
  /**
   * `true` denies every permission without `readOnlyHint` (`not-delegated`),
   * with or without a policy delegation.
   */
  readonly readOnly?: boolean;
  /**
   * The stable name the application gives this OAuth client (`ClientNames`),
   * set by the subject resolver from the verified client id; policy delegations
   * match it with `to: { kind, client }`.
   */
  readonly client?: string;
  readonly [key: string]: unknown;
};

export type AuthorizationDetail = {
  readonly type: string;
  readonly actions?: readonly string[];
  readonly [key: string]: unknown;
};

export type GnapAccess = string | Readonly<Record<string, unknown>>;

export type Delegation = {
  readonly scopes?: readonly string[];
  readonly authorizationDetails?: readonly AuthorizationDetail[];
  readonly access?: readonly GnapAccess[];
  readonly chain?: unknown;
};

export type Subject<TPrincipal extends Principal = Principal> = {
  readonly principal: TPrincipal | null;
  readonly actor?: Actor;
  readonly delegation?: Delegation;
  readonly context: Readonly<Record<string, unknown>>;
  readonly session?: string;
  readonly expiresAt?: number;
  /**
   * When the verified token was issued (`iat`), in seconds since the epoch. A
   * `VersionCache` trusts the token's `authzVersion` for its `maxStaleMs` after
   * it.
   */
  readonly issuedAt?: number;
  /**
   * The token's memberships are behind the source's authorization version:
   * `fresh` permissions deny.
   */
  readonly stale?: true;
  /**
   * The resolver checked the session against the Auth server for this request
   * (`liveSession: true`), so `{ subject: { session: { live: true } } }` holds.
   * Never read from claims.
   */
  readonly liveSession?: true;
};

export function isPrincipal(value: unknown): value is Principal {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  if ("principal" in value && "context" in value) {
    return false;
  }
  // SAFETY: value is a non-null, non-array object checked above; every field stays unknown.
  const record = value as {
    readonly id?: unknown;
    readonly roles?: unknown;
    readonly memberships?: unknown;
    readonly kind?: unknown;
    readonly issuer?: unknown;
  };
  if (typeof record.id !== "string") {
    return false;
  }
  return (
    Array.isArray(record.roles) ||
    Array.isArray(record.memberships) ||
    record.kind === "user" ||
    record.kind === "service" ||
    record.kind === "workload" ||
    record.kind === "link" ||
    record.kind === "feed" ||
    record.kind === "contact" ||
    typeof record.issuer === "string"
  );
}

export function isSubject(value: unknown): value is Subject {
  return (
    value !== null &&
    typeof value === "object" &&
    "principal" in value &&
    "context" in value &&
    typeof value.context === "object"
  );
}

export function isActor(value: unknown): value is Actor {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  // SAFETY: value is a non-null, non-array object checked above; both fields stay unknown.
  const record = value as { readonly id?: unknown; readonly kind?: unknown };
  return typeof record.id === "string" && typeof record.kind === "string";
}

export function anonymousSubject<TPrincipal extends Principal = Principal>(
  context: Readonly<Record<string, unknown>> = {},
): Subject<TPrincipal> {
  return Object.freeze({
    principal: null,
    context: Object.freeze({ ...context }),
  });
}
