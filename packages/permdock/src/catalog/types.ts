import type { ResourceRelation } from "../core/permissions.ts";

export type CatalogUsage = {
  readonly file: string;
  readonly line: number;
  readonly call: string;
};

export type CatalogPermission = {
  readonly key: string;
  readonly scope: string;
  readonly resource: string;
  readonly action: string;
  readonly arity: "instance" | "collection";
  readonly meta: Readonly<Record<string, unknown>>;
  readonly usages: readonly CatalogUsage[];
  /** Present only when the policy lists the permission in `hostable`. */
  readonly hostable?: true;
  /**
   * `true` when a code grant for the key has a condition beyond role and
   * scope, so the SQL helpers alone cannot enforce it, and when the catalog
   * was built without the policy, which leaves it unknown.
   */
  readonly rowConditions: boolean;
  /** The approvals code allows on this permission require; a hosted grant must meet each. */
  readonly approvals?: readonly CatalogApproval[];
  /** Present when a `breakGlass` override targets this permission. */
  readonly breakGlass?: CatalogBreakGlass;
};

/** A break-glass override as the catalog carries it. */
export type CatalogBreakGlass = {
  readonly overrides: readonly string[];
  readonly purpose?: readonly string[];
  readonly reason: boolean;
  readonly maxDuration?: string;
  readonly obligations: readonly string[];
};

export type CatalogApproval =
  | "human"
  | {
      readonly by?: unknown;
      readonly distinct?: boolean;
      readonly staleOn?: "resource-change";
      readonly quorum?: number;
      readonly ttl?: string;
      readonly escalation?: { readonly after: string; readonly to: unknown };
    };

export type CatalogResource = {
  readonly id: string;
  readonly schema: unknown;
  readonly definedIn?: string;
  readonly relations?: Readonly<Record<string, ResourceRelation>>;
  /** The row field an `approval: { staleOn: 'resource-change' }` binds to. */
  readonly version?: string;
  /** The boolean column that keeps ancestor grants out of a row. */
  readonly restricted?: string;
};

export type CatalogRole = {
  readonly key: string;
  /** A declared scope name, or `resource`; absent for a global role. */
  readonly on?: string;
  readonly assignable?: boolean;
  /** Fewest holders per scope instance; absent when 0. */
  readonly min?: number;
  readonly max?: number;
  readonly transferOnly?: true;
  readonly assigns?: readonly string[];
  /** Membership kinds (`via`) that may hold the role. */
  readonly for?: readonly string[];
  readonly exclusiveWith?: readonly string[];
  readonly audience?: string;
  /** Present when the role is eligible-only and activated with `permdock.activate`. */
  readonly activation?: CatalogActivation;
  /** Present when the role is a `supportAccess` role. */
  readonly supportAccess?: CatalogSupportAccess;
};

/** A role activation as the catalog carries it. */
export type CatalogActivation = {
  readonly maxDuration?: string;
  readonly justification: "required" | "optional";
  readonly approval?: boolean;
  readonly assurance?: {
    readonly maxAge?: number;
    readonly acr?: readonly string[];
    readonly amr?: readonly string[];
  };
};

/** A support-access role as the catalog carries it. */
export type CatalogSupportAccess = {
  readonly actorRequired: boolean;
  readonly group: string;
  readonly durations: readonly string[];
};

/** One declared scope, in declaration order. */
export type CatalogScope = {
  readonly name: string;
  readonly key: string;
  readonly within?: string;
};

/** A grant's `validFrom` / `validUntil` window in Unix seconds. */
export type CatalogValidity = {
  readonly from?: number;
  readonly until?: number;
};

/**
 * One code grant as the catalog carries it: the normalised shape
 * `definePolicy` produced, minus closures. `permdock diff` compares these;
 * a hosted document is authored against them.
 */
export type CatalogGrant = {
  readonly permission: string;
  readonly effect: "allow" | "deny";
  /** The role binding the grant came from; `null` for a top-level grant. */
  readonly role: string | null;
  /** The grantee selector, or an array for an intersection, in its JSON form. */
  readonly to: unknown;
  /** `global`, a declared scope name, or `{ resource }`. */
  readonly scope: string | { readonly resource: string };
  /** Portable condition on the current row; absent on a non-portable grant. */
  readonly where?: unknown;
  /** Portable condition on the next row; absent on a non-portable grant. */
  readonly check?: unknown;
  readonly approval?: CatalogApproval;
  readonly fields?: readonly string[];
  readonly validity?: CatalogValidity;
  readonly name?: string;
  readonly purpose?: readonly string[];
  readonly limit?: {
    readonly count: number;
    readonly per: string;
    readonly mode?: "hard" | "soft";
  };
  /** Present when the grant is a closure, reads the relation graph or is opaque; `where` and `check` are then omitted. */
  readonly portable?: false;
};

/** `permissions.catalog.json`, validated by `schemas/catalog-v1.json`. */
export type CatalogDocument = {
  readonly $schema: string;
  readonly version: 1;
  readonly generatedAt: string;
  readonly generator: string;
  /** `catalogFingerprint` of this document; what hosted documents pin as `catalog`. */
  readonly fingerprint?: string;
  readonly resources: Readonly<Record<string, CatalogResource>>;
  readonly permissions: readonly CatalogPermission[];
  /** The policy's scopes in order; absent when it declares none. */
  readonly scopes?: readonly CatalogScope[];
  readonly roles?: readonly CatalogRole[];
  readonly plans?: readonly { readonly key: string }[];
  /** Every code grant, canonically ordered; present when the catalog was built with the policy. */
  readonly grants?: readonly CatalogGrant[];
  /** The policy's standing delegations, canonically ordered; present when the policy declares any. */
  readonly delegations?: readonly CatalogDelegation[];
};

/** One `definePolicy({ delegations })` entry: who hands over, to which actor, which permission keys, and when. */
export type CatalogDelegation = {
  readonly from: unknown;
  readonly to: { readonly kind: string; readonly id?: string };
  readonly permissions: readonly string[];
  readonly validity?: CatalogValidity;
};
