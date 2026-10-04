import type { StandardSchemaV1 } from "@standard-schema/spec";

import type { DecisionProvider } from "./interfaces.ts";
import type { Principal } from "./subject.ts";
import type { Actor, Delegation } from "./subject.ts";

import {
  type Condition,
  type WhereShorthand,
  normalizeWhere,
} from "../conditions/index.ts";
import {
  type Approver,
  type ApproverInput,
  flattenApprovers,
  isUserApprover,
  user,
} from "./approvers.ts";
import { compact, isReadonlyArray, sole } from "./compact.ts";
import { parseDuration } from "./duration.ts";
import { sanitizeFields } from "./fields.ts";
import { freezeDeep } from "./freeze.ts";
import {
  type ActorGrantee,
  type Grantee,
  type GranteeInput,
  asGrantee,
  authenticated,
  flattenGrantee,
  isGraphRelation,
  relationHops,
  relationStart,
  roleNameOf,
  roleScopeOf,
} from "./grantee.ts";
import { assertLimit, normalizeLimit } from "./limits.ts";
import { isForbiddenKey } from "./paths.ts";
import {
  type Permission,
  type PermissionKind,
  type PermissionTree,
  type ResourceNode,
  findPermission,
  getRegistry,
  isFieldRelation,
  isPermission,
  isRegistryTree,
  isSelfParented,
  listPermissions,
} from "./permissions.ts";
import {
  type PolicyScopesInput,
  type Scope,
  type ScopeNames,
  defineScopes,
  resolveScope,
} from "./scopes.ts";
import { sha256, bytesToBase64Url } from "./sha256.ts";
import { relatesTo } from "./tenancy.ts";
import { normalizeValidity } from "./validity.ts";
import {
  type PlanTree,
  type Role as RoleLeaf,
  type RoleMeta,
  type RoleTree,
  isRole,
  listRoles,
} from "./vocabulary.ts";

export type ClosureContext = {
  readonly subject: {
    readonly principal: Principal | null;
    readonly actor?: unknown;
    readonly delegation?: unknown;
    readonly context: Readonly<Record<string, unknown>>;
  };
  readonly actor?: unknown;
  readonly delegation?: unknown;
  readonly context: Readonly<Record<string, unknown>>;
};

export type ClosureGrantFn<T = unknown> = (
  data: T,
  ctx: ClosureContext,
) => boolean;

export type { Approver, ApproverInput, UserApprover } from "./approvers.ts";
export { flattenApprovers, user } from "./approvers.ts";

/** Every approver a requirement names: `by`, each stage and `escalation.to`. */
export function approversOf(
  requirement: ApprovalRequirement,
): readonly Approver[] {
  return [
    ...flattenApprovers(requirement.by),
    ...(requirement.stages ?? []).flatMap((stage) =>
      flattenApprovers(stage.by),
    ),
    ...flattenApprovers(requirement.escalation?.to),
  ];
}

/** Who else may approve once a request has waited `after`. */
export type ApprovalEscalation = {
  /** A duration (`'4h'`) from the request's creation. */
  readonly after: string;
  readonly to: Approver | readonly Approver[];
};

/** One group of approvers; `quorum` distinct approvers of `by` complete it. */
export type ApprovalStage = {
  readonly by: Approver | readonly Approver[];
  /** Absent means 1. */
  readonly quorum?: number;
};

/**
 * `'any'`: `quorum` approvers from `by`. `'all'`: every stage completes, in
 * any order. `'sequential'`: stages complete in order; an approver signs
 * only the first incomplete stage. An approver signs once per request.
 */
export type ApprovalMode = "any" | "all" | "sequential";

export type ApprovalRequirement = {
  /** Set when `mode` is `'any'` (the default); absent under `stages`. */
  readonly by?: Approver | readonly Approver[];
  /** Absent means `'any'`. */
  readonly mode?: ApprovalMode;
  /** Set when `mode` is `'all'` or `'sequential'`. */
  readonly stages?: readonly ApprovalStage[];
  /** `false` lets the request's principal approve it; absent means `true`. */
  readonly distinct?: boolean;
  /** `'resource-change'` binds the approval to the row's `version` field. */
  readonly staleOn?: "resource-change";
  /** Distinct approvers a request needs before it is approved under `by`; absent means 1. */
  readonly quorum?: number;
  /** How long a request stays open (`'30m'`); the store's default when absent, and never longer than it. */
  readonly ttl?: string;
  readonly escalation?: ApprovalEscalation;
};

export type ApprovalOption =
  | "human"
  | {
      readonly by?: ApproverInput;
      /** `'all'` or `'sequential'` with `stages`; absent means `'any'` with `by`. */
      readonly mode?: ApprovalMode;
      readonly stages?: readonly {
        readonly by: ApproverInput;
        readonly quorum?: number;
      }[];
      /** `false` lets the request's principal approve it; absent means `true`. */
      readonly distinct?: boolean;
      /**
       * `'resource-change'`: the approval covers the row as it was when it was
       * requested. The resource must declare `version`; once that field
       * changes, resuming denies with `stale-approval`.
       */
      readonly staleOn?: "resource-change";
      /** Distinct approvers needed (an integer of at least 1); the same approver counts once. Absent means 1. */
      readonly quorum?: number;
      /** How long the request stays open (`'30m'`, `'2d'`); caps the approval store's default. */
      readonly ttl?: string;
      /** After `after` (`'4h'`), `to` may approve as well as `by`, at any open stage; same kinds as `by`. */
      readonly escalation?: {
        readonly after: string;
        readonly to: ApproverInput;
      };
    };

function asApprover(input: ApproverInput): Approver | readonly Approver[] {
  if (isReadonlyArray(input)) {
    const items: Approver[] = [];
    // SAFETY: isReadonlyArray does not narrow the element type; the only array form is ApproverInput[].
    for (const item of input as readonly ApproverInput[]) {
      items.push(...flattenApprovers(asApprover(item)));
    }
    return items;
  }
  if (isUserApprover(input)) {
    return user(input.id);
  }
  // SAFETY: arrays and user approvers returned above, so input is a GranteeInput.
  return asGrantee(input as GranteeInput);
}

/**
 * A quota on a grant. `hard` (the default) denies past `count`; `soft` grants
 * with an `over-limit` obligation. `alertAt` (a fraction of `count`, above 0
 * and at most 1) adds a `near-limit` obligation once usage reaches it.
 */
export type GrantLimit = {
  readonly count: number;
  readonly per: string;
  readonly mode?: "hard" | "soft";
  readonly alertAt?: number;
};

/** How fresh the subject's authentication must be for an elevated grant. */
export type AssuranceRequirement = {
  /** Seconds since the subject last authenticated (`assurance.authTime`). */
  readonly maxAge?: number;
  /** Authentication context class references, any of which satisfies it. */
  readonly acr?: readonly string[];
  /** Authentication methods, all of which must be present. */
  readonly amr?: readonly string[];
};

/**
 * Time-boxed role activation. A role with `activation` is never held
 * directly: a membership lists it under `eligible`, and `permdock.activate`
 * mints the elevated membership to write.
 */
export type ActivationOption = {
  /** The longest an activation may last, as a duration (`'4h'`, `'30m'`). */
  readonly maxDuration?: string;
  /** `'required'` denies an activation without a reason. */
  readonly justification?: "required" | "optional";
  /** When set, `activate` returns `approval-required` before the membership can be written. */
  readonly approval?: ApprovalOption;
  /** How fresh the activator's authentication must be. */
  readonly assurance?: AssuranceRequirement;
};

export type ActivationSpec = {
  readonly maxDuration?: string;
  readonly justification: "required" | "optional";
  readonly approval?: "human" | ApprovalRequirement;
  readonly assurance?: AssuranceRequirement;
};

/** What a break-glass grant demands before it overrides a deny. */
export type BreakGlassRequirements = {
  /** Purposes of use (`context.purpose`), any of which engages break-glass. */
  readonly purpose?: readonly string[];
  /** `true` denies unless the caller supplies `context.reason`. */
  readonly reason?: boolean;
  readonly assurance?: AssuranceRequirement;
};

export type BreakGlassOptions = {
  /** Names of the deny grants this override lifts; every other deny still wins. */
  readonly overrides?: readonly string[];
  readonly requires?: BreakGlassRequirements;
  /** The longest a break-glass session may last, as a duration. */
  readonly maxDuration?: string;
  /** Follow-ups the grant owes: each becomes an obligation on the decision. */
  readonly obligations?: readonly ("notify" | "review")[];
};

/** The normalized break-glass spec carried on a grant. */
export type BreakGlassSpec = {
  readonly overrides: readonly string[];
  readonly purpose?: readonly string[];
  readonly reason: boolean;
  readonly assurance?: AssuranceRequirement;
  readonly maxDuration?: string;
  readonly obligations: readonly ("notify" | "review")[];
};

/** How a tenant consents to support access, and for how long. */
export type SupportConsent = {
  readonly by: GranteeInput;
  /** The durations a tenant owner may pick, as duration strings. */
  readonly durations: readonly string[];
};

export type SupportAccessOptions<S extends string = string> = {
  /** The role a consented support membership holds. */
  readonly role: string;
  /** The scope the support membership sits in; defaults to `tenant`. */
  readonly on?: S;
  /** Every decision under the support membership denies with `actor-required` without an `act`. */
  readonly actorRequired?: boolean;
  readonly consent: SupportConsent;
  /** Permissions a support session never reaches, compiled to deny grants scoped to `via: 'support'`. */
  readonly forbid?: readonly (Permission | PermissionTree)[];
  /** The subgroup a consented membership records under `member.group`. */
  readonly group?: string;
};

export type SupportSpec = {
  readonly role: string;
  readonly actorRequired: boolean;
  readonly consent: {
    readonly by: Grantee | readonly Grantee[];
    readonly durations: readonly string[];
  };
  readonly group: string;
};

export type GrantOptions<T = Record<string, unknown>> = {
  readonly to?: GranteeInput;
  readonly where?: WhereShorthand<T> | Condition;
  readonly check?: WhereShorthand<T> | Condition;
  readonly approval?: ApprovalOption;
  readonly limit?: GrantLimit;
  readonly reason?: string;
  readonly fields?: readonly (keyof T & string)[];
  /** A name a `breakGlass` override may lift; only meaningful on a deny. */
  readonly name?: string;
  /** Purposes of use (`context.purpose`) that make the grant apply; non-portable. */
  readonly purpose?: readonly string[];
  /** The grant applies from this instant on (RFC 3339 string or Unix seconds); before it an allow denies with `inactive-grant` and a deny does not apply. */
  readonly validFrom?: string | number;
  /** The grant stops applying at this instant (exclusive; RFC 3339 string or Unix seconds). */
  readonly validUntil?: string | number;
};

/**
 * When a grant applies, in Unix seconds. `from` is inclusive, `until`
 * exclusive; either may be absent. Portable: `where()` drops an inactive
 * grant at the decision clock and generated RLS compares against `now()`.
 */
export type GrantValidity = {
  readonly from?: number;
  readonly until?: number;
};

/** The actor a policy delegation is for: an actor kind, narrowed to one id when `id` is set. */
export type DelegationTarget = {
  readonly kind: string;
  readonly id?: string;
};

/**
 * A normalised policy delegation: holders of `from` let actors matching `to`
 * use `permissions` (keys) on their behalf while `validity` holds, without a
 * token saying so. Attenuation only: the principal's grants still decide.
 */
export type PolicyDelegation = {
  readonly from: Grantee | readonly Grantee[];
  readonly to: DelegationTarget;
  readonly permissions: readonly string[];
  readonly validity?: GrantValidity;
};

export type DelegationInput = {
  /** Who hands over: the same subject-only selectors as `approval.by` (a role, `authenticated()`, a plan, `assurance()`); not `relation()`. */
  readonly from: GranteeInput;
  /** Which actor may act: `actor('eve')`, an actor kind, or `{ kind, id }` for one agent. */
  readonly to: ActorGrantee | string | DelegationTarget;
  /** The leaves or subtrees the actor may use; a deny grant still applies. */
  readonly permissions: readonly (Permission | PermissionTree)[];
  readonly validFrom?: string | number;
  readonly validUntil?: string | number;
};

/** A declared scope name (or the `tenant` / `team` alias), or the resource a role is held on. */
export type RoleScope<S extends string = string> =
  | S
  | Permission
  | PermissionTree
  | readonly (Permission | PermissionTree)[];

export type RoleOptions<S extends string = string> = {
  readonly on?: RoleScope<S>;
  readonly assignable?: boolean;
  /** Roles nobody may hold together with this one in the same scope instance. */
  readonly exclusiveWith?: readonly string[];
  /** Fewest holders a scope instance keeps (checked at commit); default 0. Needs a named-scope `on`. */
  readonly min?: number;
  /** Most holders a scope instance may have. Needs a named-scope `on`. */
  readonly max?: number;
  /** The holder count of a scope instance never changes: the role only moves by transfer. */
  readonly transferOnly?: boolean;
  /**
   * Roles a holder may assign and revoke. Once any role declares `assigns`,
   * a role nobody lists is assigned only by `meta.manageRoles` holders.
   */
  readonly assigns?: readonly string[];
  /** Membership kinds (`via`) that may hold the role; others hold it for nothing. */
  readonly for?: readonly string[];
  readonly meta?: RoleMeta;
  /** Time-boxed activation: the role becomes eligible-only and `activate` mints its membership. */
  readonly activation?: ActivationOption;
  /** Reserved for restricted credentials; setting it throws until it ships. */
  readonly restricted?: never;
};

/** Where a grant applies: `'global'`, a declared scope name, or one resource. */
export type GrantScope = string | { readonly resource: string };

export type Grant = {
  readonly permission: Permission;
  readonly effect: "allow" | "deny";
  readonly to: Grantee | readonly Grantee[];
  readonly role: string | null;
  readonly where?: Condition;
  readonly check?: Condition;
  readonly approval?: "human" | ApprovalRequirement;
  readonly portable: boolean;
  /** Set when `portable` is false only because the grant reads the relation graph. */
  readonly graph?: true;
  readonly closure?: ClosureGrantFn;
  readonly limit?: GrantLimit;
  readonly fields?: readonly string[];
  readonly scope: GrantScope;
  /** A name a `breakGlass` override may lift; only meaningful on a deny. */
  readonly name?: string;
  /** Purposes of use that make the grant apply (`context.purpose`); non-portable. */
  readonly purpose?: readonly string[];
  /** Set on a break-glass allow: it overrides named denies and carries obligations. */
  readonly breakGlass?: BreakGlassSpec;
  /** The membership kind (`via`) this grant applies under; others never match it. */
  readonly viaOnly?: string;
  /** Set only on a grant merged from a hosted policy document. */
  readonly hosted?: HostedGrantRef;
  /** When the grant applies; absent means always. */
  readonly validity?: GrantValidity;
};

/** Which hosted policy document and grant a merged grant came from. */
export type HostedGrantRef = {
  readonly document: string;
  readonly grant: string;
};

export type RoleBinding<S extends string = string> = {
  readonly name: string;
  readonly grants: readonly Grant[];
  readonly on?: RoleScope<S>;
  readonly assignable: boolean;
  readonly exclusiveWith?: readonly string[];
  readonly min?: number;
  readonly max?: number;
  readonly transferOnly?: boolean;
  readonly assigns?: readonly string[];
  readonly for?: readonly string[];
  readonly meta?: RoleMeta;
  /** Time-boxed activation: the role is eligible-only, and `activate` mints its membership. */
  readonly activation?: ActivationSpec;
  /** Support access: consent and `actorRequired` for a vendor-support membership. */
  readonly support?: SupportSpec;
};

export type ValidateMode = "boundary" | "always" | "never";

/** The declared scopes, in declaration order; empty when the policy declares none. */
export type PolicyScopes = readonly Scope[];

export type PolicyVocabulary = {
  readonly permissions: PermissionTree;
  readonly roles?: RoleTree;
  readonly plans?: PlanTree;
};

type VocabularyFromInput<Input> = Input extends PolicyVocabulary
  ? Input
  : {
      readonly permissions: Input & PermissionTree;
      readonly roles?: RoleTree;
      readonly plans?: PlanTree;
    };

export type Policy<
  TUser = unknown,
  TPrincipal extends Principal = Principal,
  V extends PolicyVocabulary = PolicyVocabulary,
> = {
  readonly permissions: V["permissions"];
  readonly roles: readonly RoleBinding[];
  readonly rolesByName: ReadonlyMap<string, RoleBinding>;
  readonly grants: readonly Grant[];
  readonly vocabulary: V;
  readonly scopes: PolicyScopes;
  principal(user: TUser): TPrincipal | null;
  subject(user: TUser): TPrincipal | null;
  context?(
    user: TUser,
  ):
    | Readonly<Record<string, unknown>>
    | Promise<Readonly<Record<string, unknown>>>;
  readonly validate: ValidateMode;
  readonly onDenied?: (decision: unknown) => never | void;
  readonly fingerprint: string;
  readonly resources: ReadonlyMap<string, ResourceNode>;
  readonly providers?: readonly DecisionProvider[];
  /** Permission keys a hosted policy document may grant or deny; empty by default. */
  readonly hostable: readonly string[];
  /** Permission keys that deny with `stale-credentials` when the subject's token is behind the source. */
  readonly fresh?: readonly string[];
  /** Policy delegations in declaration order; absent or empty when the policy declares none. */
  readonly delegations?: readonly PolicyDelegation[];
  readonly index: PolicyIndex;
};

/** Lookups built once per policy, so a decision does not rescan every role and grant. */
export type PolicyIndex = {
  readonly declaredRoles: ReadonlySet<string>;
  readonly supports: readonly SupportSpec[];
  /** The grants `grantList` returns, by permission key, in the same order. */
  readonly grantsByKey: ReadonlyMap<string, readonly Grant[]>;
};

export function indexPolicy(
  roles: readonly RoleBinding[],
  grants: readonly Grant[],
  vocabulary: PolicyVocabulary,
): PolicyIndex {
  const declaredRoles = new Set(roles.map((item) => item.name));
  for (const leaf of listRoles(vocabulary.roles)) {
    declaredRoles.add(leaf.key);
  }
  const supports = roles.flatMap((binding) =>
    binding.support === undefined ? [] : [binding.support],
  );
  const listed =
    grants.length > 0 ? grants : roles.flatMap((binding) => binding.grants);
  const byKey = new Map<string, Grant[]>();
  for (const grant of listed) {
    const bucket = byKey.get(grant.permission.key);
    if (bucket === undefined) {
      byKey.set(grant.permission.key, [grant]);
    } else {
      bucket.push(grant);
    }
  }
  for (const bucket of byKey.values()) {
    Object.freeze(bucket);
  }
  return freezeDeep({ declaredRoles, supports, grantsByKey: byKey });
}

export { requiresApproval } from "./approval-required.ts";

export function normalizeApproval(
  approval: ApprovalOption | undefined,
  permission?: string,
): Grant["approval"] {
  if (approval === undefined) {
    return undefined;
  }
  if (approval === "human") {
    return "human";
  }
  if (
    approval.staleOn !== undefined &&
    approval.staleOn !== "resource-change"
  ) {
    throw new Error(
      `PermDock: approval staleOn must be 'resource-change', got '${String(approval.staleOn)}'`,
    );
  }
  const label = permission ?? "a grant";
  assertQuorum(approval.quorum, "approval.quorum", label);
  if (approval.ttl !== undefined && parseDuration(approval.ttl) === undefined) {
    throw new Error(
      `PermDock: approval.ttl on '${label}' must be a duration such as '30m', got '${approval.ttl}'`,
    );
  }
  const escalation = normalizeEscalation(approval.escalation, label);
  const mode = approval.mode ?? "any";
  if (mode !== "any") {
    return compact<ApprovalRequirement>({
      mode,
      stages: normalizeStages(approval, mode, label),
      distinct: approval.distinct,
      staleOn: approval.staleOn,
      ttl: approval.ttl,
      escalation,
    });
  }
  if (approval.stages !== undefined) {
    throw new Error(
      `PermDock: approval.stages on '${label}' needs mode: 'all' or 'sequential'`,
    );
  }
  const by = approval.by === undefined ? undefined : asApprover(approval.by);
  if (
    by === undefined &&
    approval.distinct === undefined &&
    approval.staleOn === undefined &&
    approval.quorum === undefined &&
    approval.ttl === undefined &&
    escalation === undefined
  ) {
    return "human";
  }
  return compact<ApprovalRequirement>({
    by: by ?? authenticated(),
    distinct: approval.distinct,
    staleOn: approval.staleOn,
    quorum: approval.quorum,
    ttl: approval.ttl,
    escalation,
  });
}

function assertQuorum(
  quorum: number | undefined,
  name: string,
  label: string,
): void {
  if (quorum !== undefined && (!Number.isInteger(quorum) || quorum < 1)) {
    throw new Error(
      `PermDock: ${name} on '${label}' must be an integer of at least 1, got ${String(quorum)}`,
    );
  }
}

function normalizeStages(
  approval: Exclude<ApprovalOption, "human">,
  mode: ApprovalMode,
  label: string,
): readonly ApprovalStage[] {
  if (mode !== "all" && mode !== "sequential") {
    throw new Error(
      `PermDock: approval.mode on '${label}' must be 'any', 'all' or 'sequential', got '${mode}'`,
    );
  }
  if (approval.by !== undefined || approval.quorum !== undefined) {
    throw new Error(
      `PermDock: approval on '${label}' sets mode '${mode}': put by and quorum on each stage`,
    );
  }
  const stages = approval.stages ?? [];
  if (stages.length === 0) {
    throw new Error(
      `PermDock: approval mode '${mode}' on '${label}' needs at least one stage`,
    );
  }
  return stages.map((stage, index) => {
    assertQuorum(stage.quorum, `approval.stages[${index}].quorum`, label);
    const by = asApprover(stage.by);
    if (flattenApprovers(by).length === 0) {
      throw new Error(
        `PermDock: approval.stages[${index}].by on '${label}' names no approver`,
      );
    }
    return compact<ApprovalStage>({ by, quorum: stage.quorum });
  });
}

function normalizeEscalation(
  escalation:
    | { readonly after: string; readonly to: ApproverInput }
    | undefined,
  label: string,
): ApprovalEscalation | undefined {
  if (escalation === undefined) {
    return undefined;
  }
  if (parseDuration(escalation.after) === undefined) {
    throw new Error(
      `PermDock: approval.escalation.after on '${label}' must be a duration such as '4h', got '${escalation.after}'`,
    );
  }
  return { after: escalation.after, to: asApprover(escalation.to) };
}

function isClosure(value: unknown): value is ClosureGrantFn {
  return typeof value === "function";
}

function flattenPermissions(
  input: Permission | readonly Permission[] | PermissionTree,
): Permission[] {
  if (isPermission(input)) {
    return [input];
  }
  if (isReadonlyArray(input)) {
    return input.flatMap((item) => flattenPermissions(item));
  }
  // SAFETY: leaves and arrays returned above, so the remaining input is a PermissionTree.
  return [...listPermissions(input as PermissionTree)];
}

function delegationTarget(
  to: DelegationInput["to"],
  index: number,
): DelegationTarget {
  if (typeof to === "string") {
    return { kind: to };
  }
  if ("actor" in to) {
    return { kind: to.actor };
  }
  const target = compact<DelegationTarget>({ kind: to.kind, id: to.id });
  if (typeof target.kind !== "string" || target.kind === "") {
    throw new Error(
      `PermDock: delegations[${index}].to needs an actor kind, such as actor('eve')`,
    );
  }
  if (
    target.id !== undefined &&
    (typeof target.id !== "string" || target.id === "")
  ) {
    throw new Error(
      `PermDock: delegations[${index}].to.id must be a non-empty string`,
    );
  }
  return target;
}

function normalizeDelegation(
  input: DelegationInput,
  index: number,
  tree: PermissionTree,
): PolicyDelegation {
  const label = `delegations[${index}]`;
  const from = asGrantee(input.from);
  const items = flattenGrantee(from);
  if (items.length === 0) {
    throw new Error(`PermDock: ${label}.from names nobody`);
  }
  if (items.some((item) => item.kind === "relation")) {
    throw new Error(
      `PermDock: ${label}.from names a relation; a delegation is matched without a row, so name a role or another subject-only grantee`,
    );
  }
  if (items.some((item) => item.kind === "actor")) {
    throw new Error(
      `PermDock: ${label}.from names an actor; the principal hands over, the actor is \`to\``,
    );
  }
  const keys = [
    ...new Set(
      input.permissions
        .flatMap((item) => flattenPermissions(item))
        .map((leaf) => {
          if (findPermission(tree, leaf.key) === undefined) {
            throw new Error(
              `PermDock: ${label} names unknown permission '${leaf.key}'`,
            );
          }
          return leaf.key;
        }),
    ),
  ].toSorted();
  if (keys.length === 0) {
    throw new Error(`PermDock: ${label}.permissions is empty`);
  }
  return compact<PolicyDelegation>({
    from,
    to: delegationTarget(input.to, index),
    permissions: keys,
    validity: normalizeValidity(input, label),
  });
}

function resolveRoleScope(on: RoleScope | undefined): Grant["scope"] {
  if (on === undefined) {
    return "global";
  }
  if (typeof on === "string") {
    if (on === "global" || on === "resource") {
      throw new Error(`PermDock: role on: '${on}' is not a scope name`);
    }
    return on;
  }
  // SAFETY: strings returned above; flattenPermissions recurses, so trees inside an array work.
  const permissions = flattenPermissions(
    on as Permission | PermissionTree | readonly Permission[],
  );
  const names = new Set(permissions.map((permission) => permission.resource));
  const [resource] = names;
  if (names.size !== 1 || resource === undefined) {
    throw new Error(
      "PermDock: role on: resource must name exactly one resource",
    );
  }
  return { resource };
}

function makeGrant(
  permission: Permission,
  effect: "allow" | "deny",
  condition: GrantOptions | ClosureGrantFn | undefined,
): Omit<Grant, "role" | "scope"> {
  const toInput = isClosure(condition) ? undefined : condition?.to;
  const to =
    toInput === undefined
      ? ({
          kind: "role",
          role: "",
          scope: "global",
        } satisfies Grantee)
      : asGrantee(toInput);
  if (isClosure(condition)) {
    return {
      permission,
      effect,
      to,
      portable: false,
      closure: condition,
    };
  }
  const whereInput = condition?.where;
  const checkInput = condition?.check;
  if (whereInput !== undefined && permission.kind === "collection") {
    throw new Error(
      `PermDock: where is not allowed on collection action '${permission.key}'`,
    );
  }
  const where =
    whereInput === undefined ? undefined : normalizeWhere(whereInput);
  const check =
    checkInput === undefined ? undefined : normalizeWhere(checkInput);
  assertLimit(condition?.limit, permission.key);
  const purpose =
    condition?.purpose === undefined || condition.purpose.length === 0
      ? undefined
      : Object.freeze([...new Set(condition.purpose)]);
  const portable = condition?.limit === undefined && purpose === undefined;
  return compact<Omit<Grant, "role" | "scope">>({
    permission,
    effect,
    to,
    where,
    check,
    approval: normalizeApproval(condition?.approval, permission.key),
    portable,
    limit: normalizeLimit(condition?.limit),
    fields: sanitizeFields(condition?.fields),
    name: condition?.name,
    purpose,
    validity: normalizeValidity(condition ?? {}, permission.key),
  });
}

export type GrantCondition<T, K extends PermissionKind> = K extends "collection"
  ? Omit<GrantOptions<T>, "where" | "fields"> | ClosureGrantFn<T>
  : GrantOptions<T> | ClosureGrantFn<T>;

export function allow<T, K extends PermissionKind = PermissionKind>(
  permission: Permission<string, T, K> | readonly Permission<string, T, K>[],
  condition?: GrantCondition<T, K>,
): Omit<Grant, "role" | "scope"> | Omit<Grant, "role" | "scope">[] {
  const permissions = flattenPermissions(permission);
  // SAFETY: T and K only type the caller's closure and where input; makeGrant takes the erased form.
  const grants = permissions.map((leaf) =>
    makeGrant(
      leaf,
      "allow",
      condition as GrantOptions | ClosureGrantFn | undefined,
    ),
  );
  return sole(grants) ?? grants;
}

export function deny<T, K extends PermissionKind = PermissionKind>(
  permission: Permission<string, T, K> | readonly Permission<string, T, K>[],
  condition?: GrantCondition<T, K>,
): Omit<Grant, "role" | "scope"> | Omit<Grant, "role" | "scope">[] {
  const permissions = flattenPermissions(permission);
  // SAFETY: T and K only type the caller's closure and where input; makeGrant takes the erased form.
  const grants = permissions.map((leaf) =>
    makeGrant(
      leaf,
      "deny",
      condition as GrantOptions | ClosureGrantFn | undefined,
    ),
  );
  return sole(grants) ?? grants;
}

function flattenGrants(
  grants: readonly (
    | Omit<Grant, "role" | "scope">
    | readonly Omit<Grant, "role" | "scope">[]
  )[],
): Omit<Grant, "role" | "scope">[] {
  const out: Omit<Grant, "role" | "scope">[] = [];
  for (const grant of grants) {
    if (Array.isArray(grant)) {
      // SAFETY: Array.isArray does not narrow a readonly array; the array form is a grant list.
      out.push(...(grant as readonly Omit<Grant, "role" | "scope">[]));
    } else {
      // SAFETY: arrays take the branch above, so this is a single grant.
      out.push(grant as Omit<Grant, "role" | "scope">);
    }
  }
  return out;
}

type RoleGrants = readonly (
  | Omit<Grant, "role" | "scope">
  | readonly Omit<Grant, "role" | "scope">[]
)[];

/** A role held at a named scope: `on` is checked against `definePolicy({ scopes })`. */
export function role<const S extends string>(
  name: string | RoleLeaf,
  grants: RoleGrants,
  options: RoleOptions<S> & { readonly on: S },
): RoleBinding<S>;
/** A global role, or one held on a resource. */
export function role(
  name: string | RoleLeaf,
  grants: RoleGrants,
  options?: RoleOptions<never>,
): RoleBinding<never>;
/** Options built at runtime: the scope name is only checked by `definePolicy`. */
export function role(
  name: string | RoleLeaf,
  grants: RoleGrants,
  options?: RoleOptions,
): RoleBinding;
export function role(
  name: string | RoleLeaf,
  grants: RoleGrants,
  options?: RoleOptions,
): RoleBinding {
  if (options !== undefined && Object.hasOwn(options, "restricted")) {
    throw new Error(`PermDock: role option 'restricted' is reserved`);
  }
  const leaf = isRole(name) ? name : undefined;
  // SAFETY: the right side runs only when name is not a role leaf, so it is the string form.
  const roleName = leaf?.key ?? (name as string);
  const scope = resolveRoleScope(options?.on ?? leaf?.on);
  const assignable =
    options?.assignable ?? leaf?.assignable ?? scope !== "global";
  const rules = roleRules(roleName, scope, options);
  const activation = normalizeActivation(roleName, options?.activation);
  const roleGrantee = asGrantee(
    freezeDeep({
      kind: "role" as const,
      role: roleName,
      scope,
    }),
  );
  const normalised = flattenGrants(grants).map((grant) => {
    const items = flattenGrantee(grant.to);
    const first = items[0];
    const roleTo = items.length === 1 && first?.kind === "role";
    const to = roleTo ? roleGrantee : grant.to;
    return freezeDeep({
      ...grant,
      to,
      role: roleName,
      scope: roleScopeOf(to, scope),
    });
  });
  return freezeDeep(
    compact<RoleBinding>({
      name: roleName,
      grants: normalised,
      on: options?.on ?? leaf?.on,
      assignable,
      exclusiveWith: options?.exclusiveWith,
      ...rules,
      meta: options?.meta ?? leaf?.meta,
      activation,
    }),
  );
}

/**
 * A role with `activation` is eligible-only: it needs a positive `maxDuration`
 * (Doctor PD033 warns without one). `justification` defaults to `'optional'`.
 */
function activationApproval(
  option: ApprovalOption | undefined,
  roleName: string,
): Grant["approval"] {
  const label = `activation of '${roleName}'`;
  const approval = normalizeApproval(option, label);
  if (
    approval !== undefined &&
    approval !== "human" &&
    approversOf(approval).some((item) => item.kind === "relation")
  ) {
    throw new Error(
      `PermDock: approval on ${label} names a relation; an activation has no row to read it on`,
    );
  }
  return approval;
}

function normalizeActivation(
  roleName: string,
  option: ActivationOption | undefined,
): ActivationSpec | undefined {
  if (option === undefined) {
    return undefined;
  }
  const justification = option.justification ?? "optional";
  if (justification !== "required" && justification !== "optional") {
    throw new Error(
      `PermDock: role '${roleName}' activation justification must be 'required' or 'optional'`,
    );
  }
  return compact<ActivationSpec>({
    maxDuration: option.maxDuration,
    justification,
    approval: activationApproval(option.approval, roleName),
    assurance: normalizeAssurance(option.assurance),
  });
}

export function normalizeAssurance(
  input: AssuranceRequirement | undefined,
): AssuranceRequirement | undefined {
  if (input === undefined) {
    return undefined;
  }
  const acr =
    input.acr === undefined || input.acr.length === 0
      ? undefined
      : Object.freeze([...input.acr]);
  const amr =
    input.amr === undefined || input.amr.length === 0
      ? undefined
      : Object.freeze([...input.amr]);
  const maxAge =
    typeof input.maxAge === "number" && input.maxAge >= 0
      ? input.maxAge
      : undefined;
  if (acr === undefined && amr === undefined && maxAge === undefined) {
    return undefined;
  }
  return compact<AssuranceRequirement>({ maxAge, acr, amr });
}

type RoleRules = Pick<
  RoleBinding,
  "min" | "max" | "transferOnly" | "assigns" | "for"
>;

function nameList(
  roleName: string,
  option: string,
  value: unknown,
): readonly string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (
    !Array.isArray(value) ||
    value.some(
      (item) => typeof item !== "string" || item === "" || isForbiddenKey(item),
    )
  ) {
    throw new Error(
      `PermDock: role '${roleName}' ${option} must be a list of names`,
    );
  }
  // SAFETY: the check above throws unless value is an array of non-empty, safe strings.
  return [...new Set(value as readonly string[])];
}

function holderCount(
  roleName: string,
  option: string,
  value: unknown,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(
      `PermDock: role '${roleName}' ${option} must be a whole number of holders`,
    );
  }
  return value;
}

/** Ownership rules count holders per scope instance, so they need a named-scope role. */
function roleRules(
  roleName: string,
  scope: Grant["scope"],
  options: RoleOptions | undefined,
): RoleRules {
  const min = holderCount(roleName, "min", options?.min);
  const max = holderCount(roleName, "max", options?.max);
  const transferOnly = options?.transferOnly;
  if (transferOnly !== undefined && typeof transferOnly !== "boolean") {
    throw new Error(
      `PermDock: role '${roleName}' transferOnly must be a boolean`,
    );
  }
  if (max !== undefined && max < 1) {
    throw new Error(`PermDock: role '${roleName}' max must be at least 1`);
  }
  if (min !== undefined && max !== undefined && min > max) {
    throw new Error(`PermDock: role '${roleName}' min must not exceed max`);
  }
  const counted =
    (min !== undefined && min > 0) ||
    max !== undefined ||
    transferOnly === true;
  if (counted && (typeof scope !== "string" || scope === "global")) {
    throw new Error(
      `PermDock: role '${roleName}' min, max and transferOnly need on: '<scope>'`,
    );
  }
  return compact<RoleRules>({
    min,
    max,
    transferOnly,
    assigns: nameList(roleName, "assigns", options?.assigns),
    for: nameList(roleName, "for", options?.for),
  });
}

function canonicalPolicy(
  grants: readonly Grant[],
  delegations: readonly PolicyDelegation[],
): string {
  const payload = canonicalGrants(grants);
  if (delegations.length === 0) {
    return payload;
  }
  return `${payload}\n${JSON.stringify(delegations)}`;
}

function canonicalGrants(grants: readonly Grant[]): string {
  const payload = grants.map((grant) => ({
    permission: grant.permission.key,
    effect: grant.effect,
    to: grant.to,
    role: grant.role,
    where: grant.where,
    check: grant.check,
    approval: grant.approval,
    portable: grant.portable,
    fields: grant.fields,
    scope: grant.scope,
    name: grant.name,
    purpose: grant.purpose,
    breakGlass: grant.breakGlass,
    viaOnly: grant.viaOnly,
    validity: grant.validity,
  }));
  return JSON.stringify(payload);
}

function assertParentGraph(resources: ReadonlyMap<string, ResourceNode>): void {
  for (const node of resources.values()) {
    if (node.parent === undefined) {
      continue;
    }
    if (!resources.has(node.parent.resource)) {
      throw new Error(
        `PermDock: resource '${node.name}' parents unknown resource '${node.parent.resource}'`,
      );
    }
  }
}

/**
 * Graph relation grantees must reach their resource: `through: 'parent'` from
 * the row to its parent resource or along its own self-parent, and never over
 * a `memberOf` relation, which is tenancy, not the object graph.
 */
function assertRelationGrants(
  grants: readonly Grant[],
  resources: ReadonlyMap<string, ResourceNode>,
): void {
  for (const grant of grants) {
    for (const item of flattenGrantee(grant.to)) {
      if (item.kind !== "relation" || !isGraphRelation(item, resources)) {
        continue;
      }
      const label = `grant ${grant.permission.key} relation '${item.relation}'`;
      const target = resources.get(item.resource);
      const spec = target?.relations[item.relation];
      if (target === undefined || spec === undefined) {
        throw new Error(
          `PermDock: ${label}: ${item.resource} does not declare it`,
        );
      }
      if (isFieldRelation(spec) && spec.memberOf !== undefined) {
        throw new Error(
          `PermDock: ${label} is a memberOf relation; through walks the object graph, not scopes`,
        );
      }
      const row = resources.get(grant.permission.resource);
      if (Array.isArray(item.through)) {
        if (relationHops(item, row, resources) === undefined) {
          throw new Error(
            `PermDock: ${label}: the links [${item.through.join(", ")}] from ${grant.permission.resource} do not end on ${target.name}${(item.depth ?? 0) > 0 ? ` (or ${target.name} does not parent itself for depth)` : ""}`,
          );
        }
        continue;
      }
      if (
        item.through === "parent" &&
        target.name === row?.name &&
        !isSelfParented(target)
      ) {
        throw new Error(
          `PermDock: ${label}: through: 'parent' needs ${target.name} to parent itself`,
        );
      }
      if (relationStart(item, row, target) === undefined) {
        throw new Error(
          item.through === undefined
            ? `PermDock: ${label} is on ${target.name}, not ${grant.permission.resource}; add through: 'parent'`
            : `PermDock: ${label}: ${grant.permission.resource} has no parent on ${target.name}`,
        );
      }
    }
  }
}

function scopeOfGrant(
  scope: Grant["scope"],
  declared: readonly Scope[],
): Grant["scope"] {
  if (typeof scope !== "string" || scope === "global") {
    return scope;
  }
  const resolved = resolveScope(declared, scope);
  if (resolved === undefined) {
    throw new Error(
      `PermDock: definePolicy({ scopes }) must declare '${scope}' for on: '${scope}' roles`,
    );
  }
  return resolved;
}

function rescopeGrantee(
  to: Grant["to"],
  declared: readonly Scope[],
): Grant["to"] {
  const items = flattenGrantee(to);
  if (!items.some((item) => item.kind === "role")) {
    return to;
  }
  const mapped = items.map((item) =>
    item.kind === "role"
      ? freezeDeep({ ...item, scope: scopeOfGrant(item.scope, declared) })
      : item,
  );
  if (Array.isArray(to)) {
    return freezeDeep(mapped);
  }
  const [single] = mapped;
  return single ?? to;
}

/** Resolves `tenant` / `team` aliases to declared names; an undeclared scope throws. */
function rescopeGrant(grant: Grant, declared: readonly Scope[]): Grant {
  const scope = scopeOfGrant(grant.scope, declared);
  const to = rescopeGrantee(grant.to, declared);
  if (scope === grant.scope && to === grant.to) {
    return grant;
  }
  return freezeDeep({ ...grant, scope, to });
}

function rescopeBinding(
  binding: RoleBinding,
  declared: readonly Scope[],
): RoleBinding {
  const grants = binding.grants.map((grant) => rescopeGrant(grant, declared));
  const on =
    typeof binding.on === "string"
      ? scopeOfGrant(binding.on, declared)
      : binding.on;
  // SAFETY: a string on resolves to a declared scope name; any other on is passed through as is.
  return freezeDeep(
    compact<RoleBinding>({ ...binding, grants, on: on as RoleScope }),
  );
}

/**
 * No implicit cascade: a grant on scope S reaches a row only through the row's
 * own S key, so every resource an instance grant on S touches declares a
 * `memberOf: S` relation on that key. Without it `where()` and RLS could not
 * narrow the rows.
 */
function assertScopeKeys(
  grants: readonly Grant[],
  scopes: readonly Scope[],
  resources: ReadonlyMap<string, ResourceNode>,
): void {
  for (const grant of grants) {
    if (
      typeof grant.scope !== "string" ||
      grant.scope === "global" ||
      grant.permission.kind !== "instance"
    ) {
      continue;
    }
    const key = scopes.find((scope) => scope.name === grant.scope)?.key;
    const node = resources.get(grant.permission.resource);
    if (
      key === undefined ||
      node === undefined ||
      relatesTo(node, key, grant.scope, scopes)
    ) {
      continue;
    }
    throw new Error(
      `PermDock: resource '${node.name}' needs relations: { <name>: { field: '${key}', memberOf: '${grant.scope}' } } for ${grant.permission.key} on '${grant.scope}' roles`,
    );
  }
}

/**
 * A stale-on-change approval needs a row to version: an instance permission
 * whose resource declares `version`.
 */
function assertApprovalVersions(
  grants: readonly Grant[],
  resources: ReadonlyMap<string, ResourceNode>,
): void {
  for (const grant of grants) {
    const approval = grant.approval;
    if (
      approval === undefined ||
      approval === "human" ||
      approval.staleOn === undefined
    ) {
      continue;
    }
    if (grant.permission.kind !== "instance") {
      throw new Error(
        `PermDock: approval staleOn on '${grant.permission.key}' needs an instance action; a collection action has no row to version`,
      );
    }
    const node = resources.get(grant.permission.resource);
    if (node?.version === undefined) {
      throw new Error(
        `PermDock: approval staleOn on '${grant.permission.key}' needs resource(..., { version: '<field>' }) on '${grant.permission.resource}'`,
      );
    }
  }
}

/**
 * A relation approver is checked by id, from the requested row: the
 * relation lives on the permission's own resource (optionally up its parent
 * chain), or at the end of a list of links from it.
 */
export function assertApprovalRelations(
  grants: readonly Pick<Grant, "permission" | "approval">[],
  resources: ReadonlyMap<string, ResourceNode>,
): void {
  for (const grant of grants) {
    const approval = grant.approval;
    if (approval === undefined || approval === "human") {
      continue;
    }
    for (const item of approversOf(approval)) {
      if (item.kind !== "relation") {
        continue;
      }
      const label = `${grant.permission.key}: approver relation '${item.relation}'`;
      if (grant.permission.kind !== "instance") {
        throw new Error(
          `PermDock: ${label} needs an instance action; a collection action has no row to read it on`,
        );
      }
      const end = approverRelationResource(
        grant.permission.resource,
        item.through,
        resources,
      );
      if (end !== item.resource) {
        throw new Error(
          `PermDock: ${label} must live on '${grant.permission.resource}' or at the end of its through links`,
        );
      }
      if (
        resources.get(item.resource)?.relations[item.relation] === undefined
      ) {
        throw new Error(
          `PermDock: ${label} is not declared on '${item.resource}'`,
        );
      }
    }
  }
}

/** The resource a relation approver's `through` reaches from `start`, or `undefined`. */
function approverRelationResource(
  start: string,
  through: "parent" | readonly string[] | undefined,
  resources: ReadonlyMap<string, ResourceNode>,
): string | undefined {
  if (through === undefined) {
    return start;
  }
  if (through === "parent") {
    return isSelfParented(resources.get(start)) ? start : undefined;
  }
  let current: string | undefined = start;
  for (const name of through) {
    const node: ResourceNode | undefined =
      current === undefined ? undefined : resources.get(current);
    current =
      node !== undefined && Object.hasOwn(node.links, name)
        ? node.links[name]?.resource
        : undefined;
  }
  return current;
}

function isVocabularyInput(value: unknown): value is PolicyVocabulary {
  return (
    value !== null &&
    typeof value === "object" &&
    "permissions" in value &&
    // SAFETY: permissions is checked to be a key; isRegistryTree then tests its registry brand.
    isRegistryTree((value as PolicyVocabulary).permissions)
  );
}

export function completeGrant(grant: Omit<Grant, "role" | "scope">): Grant {
  const to = flattenGrantee(grant.to);
  const first = to[0];
  const placeholder =
    to.length === 1 && first?.kind === "role" && first.role === "";
  if (placeholder) {
    throw new Error("PermDock: grant is missing to");
  }
  return freezeDeep({
    ...grant,
    role: roleNameOf(grant.to),
    scope: roleScopeOf(grant.to),
  });
}

function mergeBindings(items: readonly RoleBinding[]): {
  readonly roles: readonly RoleBinding[];
  readonly rolesByName: Map<string, RoleBinding>;
} {
  const merged = new Map<string, RoleBinding>();
  for (const item of items) {
    const existing = merged.get(item.name);
    if (existing === undefined) {
      merged.set(item.name, item);
      continue;
    }
    merged.set(
      item.name,
      freezeDeep(
        compact<RoleBinding>({
          name: item.name,
          grants: [...existing.grants, ...item.grants],
          on: existing.on,
          assignable: existing.assignable,
          exclusiveWith: existing.exclusiveWith ?? item.exclusiveWith,
          min: existing.min ?? item.min,
          max: existing.max ?? item.max,
          transferOnly: existing.transferOnly ?? item.transferOnly,
          assigns: existing.assigns ?? item.assigns,
          for: existing.for ?? item.for,
          meta: existing.meta ?? item.meta,
          activation: existing.activation ?? item.activation,
          support: existing.support ?? item.support,
        }),
      ),
    );
  }
  return { roles: [...merged.values()], rolesByName: merged };
}

export type DefinePolicyOptions<
  TUser,
  TPrincipal extends Principal,
  S extends PolicyScopesInput = PolicyScopesInput,
> = {
  readonly roles?: readonly RoleBinding<ScopeNames<S>>[];
  readonly grants?: readonly (
    | Omit<Grant, "role" | "scope">
    | readonly Omit<Grant, "role" | "scope">[]
    | Grant
  )[];
  /**
   * Named scopes in order, each with the row field holding its id and an
   * optional parent (`within`, an earlier scope). `tenant` and `team` alias
   * the first and second scope.
   */
  readonly scopes?: S;
  readonly principal?: (user: TUser) => TPrincipal | null;
  readonly subject?: (user: TUser) => TPrincipal | null;
  readonly context?: (
    user: TUser,
  ) =>
    | Readonly<Record<string, unknown>>
    | Promise<Readonly<Record<string, unknown>>>;
  readonly validate?: ValidateMode;
  readonly onDenied?: (decision: unknown) => never | void;
  readonly providers?: readonly DecisionProvider[];
  /**
   * Leaves or subtrees a hosted policy document (`PolicySource`) may touch.
   * The default is none, so a policy without it ignores every hosted grant.
   */
  readonly hostable?: readonly (Permission | PermissionTree)[];
  /**
   * Sensitive permissions that need an up-to-date token: when the subject's
   * memberships come from a token behind the `MembershipSource` version, they
   * deny with `stale-credentials`.
   */
  readonly fresh?: readonly (Permission | PermissionTree)[];
  /**
   * Standing delegations: holders of `from` let actors matching `to` use
   * `permissions` for them without a token saying so. A token delegation on
   * the call still applies as well; both must cover.
   */
  readonly delegations?: readonly DelegationInput[];
};

export function definePolicy<
  TUser,
  TPrincipal extends Principal,
  const Input extends PermissionTree | PolicyVocabulary,
  const S extends PolicyScopesInput = PolicyScopesInput,
>(
  permissions: Input,
  options: DefinePolicyOptions<TUser, TPrincipal, S>,
): Policy<TUser, TPrincipal, VocabularyFromInput<Input>> {
  // SAFETY: Input is a vocabulary or a tree; each branch builds the VocabularyFromInput shape.
  const vocabulary = (
    isVocabularyInput(permissions)
      ? permissions
      : { permissions: permissions as PermissionTree }
  ) as VocabularyFromInput<Input>;
  const tree = vocabulary.permissions;
  const mapper = options.principal ?? options.subject;
  if (mapper === undefined) {
    throw new Error("PermDock: definePolicy requires principal or subject");
  }
  const resources = getRegistry(tree);
  assertParentGraph(resources);
  const scopes = defineScopes(options.scopes);
  const { roles, rolesByName } = mergeBindings(
    (options.roles ?? []).map((binding) => rescopeBinding(binding, scopes)),
  );
  const declared = new Set(roles.map((item) => item.name));
  for (const leaf of listRoles(vocabulary.roles)) {
    declared.add(leaf.key);
  }
  for (const binding of roles) {
    for (const name of binding.assigns ?? []) {
      if (!declared.has(name)) {
        throw new Error(
          `PermDock: role '${binding.name}' names undeclared role '${name}'`,
        );
      }
    }
  }
  const fromBindings = roles.flatMap((item) => item.grants);
  const fromGrants = flattenGrants(options.grants ?? [])
    .map(completeGrant)
    .map((grant) => rescopeGrant(grant, scopes));
  const grants = [...fromBindings, ...fromGrants];
  assertScopeKeys(grants, scopes, resources);
  assertApprovalVersions(grants, resources);
  assertApprovalRelations(grants, resources);
  assertRelationGrants(grants, resources);
  const delegations = (options.delegations ?? []).map((item, index) =>
    normalizeDelegation(item, index, tree),
  );
  const fingerprint = bytesToBase64Url(
    sha256(canonicalPolicy(grants, delegations)),
  );
  const hostable = [
    ...new Set(
      (options.hostable ?? []).flatMap((item) =>
        flattenPermissions(item).map((leaf) => leaf.key),
      ),
    ),
  ].toSorted();
  const fresh = [
    ...new Set(
      (options.fresh ?? []).flatMap((item) =>
        flattenPermissions(item).map((leaf) => leaf.key),
      ),
    ),
  ].toSorted();
  // SAFETY: TUser and TPrincipal only type options.principal, the mapper stored here as is.
  return freezeDeep({
    permissions: tree,
    roles,
    rolesByName,
    grants,
    vocabulary,
    scopes,
    principal: mapper,
    subject: mapper,
    context: options.context,
    validate: options.validate ?? "boundary",
    onDenied: options.onDenied,
    fingerprint,
    resources,
    providers: options.providers,
    hostable,
    fresh,
    delegations: delegations.length === 0 ? undefined : delegations,
    index: indexPolicy(roles, grants, vocabulary),
  }) as Policy<TUser, TPrincipal, VocabularyFromInput<Input>>;
}

export type MembershipFixture = {
  readonly principal?: string;
  readonly tenant?: string;
  readonly roles: readonly string[];
};

export type SeparationConflict = {
  readonly principal: string;
  readonly tenant?: string;
  readonly roles: readonly [string, string];
};

function exclusivePairs(
  policy: Policy,
): ReadonlyMap<string, readonly string[]> {
  const pairs = new Map<string, readonly string[]>();
  for (const binding of policy.roles) {
    if (binding.exclusiveWith !== undefined) {
      pairs.set(binding.name, binding.exclusiveWith);
    }
  }
  return pairs;
}

export function grantList(policy: Policy): readonly Grant[] {
  if (policy.grants !== undefined && policy.grants.length > 0) {
    return policy.grants;
  }
  return policy.roles.flatMap((binding) => binding.grants);
}

export function declaredRoleNames(policy: Policy): ReadonlySet<string> {
  return policy.index.declaredRoles;
}

export function separationConflicts(
  policy: Policy,
  memberships: readonly MembershipFixture[],
): readonly SeparationConflict[] {
  const exclusive = exclusivePairs(policy);
  const seen = new Set<string>();
  const conflicts: SeparationConflict[] = [];
  for (const membership of memberships) {
    const held = new Set(membership.roles);
    for (const name of held) {
      for (const other of exclusive.get(name) ?? []) {
        if (!held.has(other)) {
          continue;
        }
        // SAFETY: sorting a two-element array keeps both elements.
        const pair = [name, other].toSorted() as [string, string];
        const key = `${membership.principal ?? ""}:${membership.tenant ?? ""}:${pair.join("+")}`;
        if (seen.has(key)) {
          continue;
        }
        seen.add(key);
        conflicts.push(
          compact<SeparationConflict>({
            principal: membership.principal ?? "",
            tenant: membership.tenant,
            roles: pair,
          }),
        );
      }
    }
  }
  return conflicts;
}

export type PrincipalOf<P> =
  P extends Policy<unknown, infer TPrincipal> ? TPrincipal : Principal;

export type SubjectOf<P> = {
  readonly principal: PrincipalOf<P> | null;
  readonly actor?: Actor;
  readonly delegation?: Delegation;
  readonly context: Readonly<Record<string, unknown>>;
  readonly session?: string;
  readonly expiresAt?: number;
};

export function inferOutput<T>(
  schema: StandardSchemaV1<unknown, T> | undefined,
): T | undefined {
  // SAFETY: a typing helper only; callers read the type T and never use the returned value as data.
  return schema as unknown as T | undefined;
}
