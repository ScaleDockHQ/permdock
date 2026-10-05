import type { LoadedApprovalPolicies } from "./approval-policies.ts";
import type { Decision, ExplainedDecision } from "./decision.ts";
import type { GranteeMatch } from "./grantee.ts";
import type {
  AuthEvent,
  DecisionSink,
  LimitStore,
  MembershipSource,
  RelationSource,
  RoleSource,
  Snapshot,
  SnapshotAssignable,
} from "./interfaces.ts";
import type {
  DecideOptions,
  DeriveOptions,
  PermDock,
  SimulateOptions,
  WhereResult,
} from "./permdock.ts";
import type { Permission } from "./permissions.ts";
import type { Grant, Policy } from "./policy.ts";
import type { CustomRole, Membership, Principal, Subject } from "./subject.ts";
import type { Role } from "./vocabulary.ts";

import { hasConditionOp } from "../conditions/ast.ts";
import { approvalPoliciesFor } from "./approval-policies.ts";
import {
  type ArazzoPlan,
  type ArazzoSimulateInput,
  isArazzoSimulateInput,
  simulateArazzo,
} from "./arazzo.ts";
import { canonicalJson } from "./canonical-json.ts";
import { compact, isReadonlyArray } from "./compact.ts";
import {
  type CustomGrant,
  ceilingGrants,
  customGrantsFor,
  customRoleScope,
  holdsCustomRole,
  holdsGlobalCustomRole,
  resolveCustomRole,
  roleAllowKeys,
  tenantCustomRoles,
} from "./custom-roles.ts";
import { delegatedPermissions } from "./delegation.ts";
import { type ActivateInput, activate } from "./elevated.ts";
import {
  PermDockApprovalRequiredError,
  PermDockDeniedError,
  PermDockValidationError,
  approvalMessage,
  deniedMessage,
} from "./errors.ts";
import {
  assignableNamesFor,
  customRolesFor,
  declaredRoleNames,
  evaluate,
  expandRoleNames,
} from "./evaluate.ts";
import { type EvalEnv, emitSafe, emptyListeners, finish } from "./events.ts";
import { pickVisible } from "./fields.ts";
import { freezeDeep } from "./freeze.ts";
import { combineWhere, flattenGrantee, matchGrantee } from "./grantee.ts";
import {
  type RoleChange,
  type RoleChangeDecision,
  type RoleChangeOptions,
  applyRoleKinds,
  audiencesOf,
  decideRoleChange,
  rankRoles,
  roleMeta,
  usesAssigns,
} from "./ownership.ts";
import {
  getResource,
  isPrincipalRelation,
  listPermissions,
} from "./permissions.ts";
import { grantList, levelCondition, levelNames } from "./policy.ts";
import {
  type RelationCache,
  pendingRelations,
  relationReader,
} from "./relations.ts";
import {
  normalizeMemberships,
  resolveScope,
  rootScope,
  scopeList,
  tenantOf,
} from "./scopes.ts";
import { buildSnapshot, signSnapshot, snapshotGrant } from "./snapshot.ts";
import {
  heldRoleNamesIn,
  isMembershipExpired,
  nowSeconds,
  partitionsOf,
  relatesTo,
  resolveActiveTenant,
  tenantsOf,
} from "./tenancy.ts";
import { isThenable } from "./thenable.ts";
import { findRole, listRoles, synthesiseRole } from "./vocabulary.ts";
import { whereFromGrants } from "./where-scope.ts";
import { whoCan } from "./who-can.ts";

/** Each round reads one more layer: link hops, then the chain, then nested groups. */
const LOAD_ROUNDS = 48;

/** A grant on a relation with a `period` is decided on the server, where the clock is. */
function periodBound(policy: Policy, grant: Grant): boolean {
  const relations = policy.resources.get(grant.permission.resource)?.relations;
  return flattenGrantee(grant.to).some((item) => {
    if (item.kind !== "relation") {
      return false;
    }
    const spec = relations?.[item.relation];
    return isPrincipalRelation(spec) && spec.period !== undefined;
  });
}

function includePrefixes(
  include:
    | readonly (Permission | { readonly [key: string]: unknown })[]
    | undefined,
): readonly string[] | undefined {
  if (include === undefined) {
    return undefined;
  }
  return include.map((item) => {
    if ("key" in item && typeof item.key === "string") {
      return item.key;
    }
    // SAFETY: include takes leaves or resource nodes, the shapes listPermissions walks.
    const leaves = listPermissions(item as never);
    const first = leaves[0];
    if (first === undefined) {
      return "";
    }
    const parts = first.key.split(".");
    parts.pop();
    return parts.join(".");
  });
}

/**
 * Role names held in `tenant` on live memberships, global roles included, in
 * rank order. With `scope`, only the roles of that scope's memberships (and
 * instance `id`).
 */
function heldRoleNames(
  policy: Policy,
  subject: Subject,
  tenant?: string,
  only?: { readonly scope?: string; readonly id?: string },
  now?: number,
): readonly string[] {
  if (subject.principal === null) {
    return [];
  }
  const scopes = scopeList(policy.scopes);
  const scope =
    only?.scope === undefined ? undefined : resolveScope(scopes, only.scope);
  if (only?.scope !== undefined && scope === undefined) {
    return [];
  }
  const names = new Set<string>(
    scope === undefined ? (subject.principal.roles ?? []) : [],
  );
  for (const membership of subject.principal.memberships ?? []) {
    if (isMembershipExpired(membership, now)) {
      continue;
    }
    const matches =
      scope === undefined
        ? tenantOf(membership, scopes) === tenant
        : membership.scope === scope &&
          (only?.id === undefined || membership.id === only.id);
    if (!matches) {
      continue;
    }
    for (const role of membership.roles) {
      names.add(role);
    }
  }
  return rankRoles(policy, [...names]);
}

function roleLeaf(policy: Policy, name: string): Role {
  const binding = policy.rolesByName.get(name);
  return (
    findRole(policy.vocabulary?.roles, name) ??
    synthesiseRole(
      name,
      compact({
        on: typeof binding?.on === "string" ? binding.on : undefined,
        assignable: binding?.assignable,
        meta: binding?.meta,
      }),
    )
  );
}

/**
 * The grant with its grantee's row condition. A graph relation needs the
 * `RelationSource`, which snapshots and `where()` do not carry, so the grant
 * becomes server-only (`portable: false`) there.
 */
function graphAware(grant: Grant, where: Grant["where"]): Grant {
  const combined = combineWhere(grant.where, where);
  const graph = hasConditionOp(combined, "related");
  return freezeDeep(
    compact({
      ...grant,
      where: combined,
      portable: graph ? false : grant.portable,
      graph: graph && grant.portable ? (true as const) : undefined,
    }),
  );
}

/**
 * `where()` keeps a grant that is server-only because it reads the graph:
 * its `related` nodes compile to subqueries given relation mappings.
 */
function whereGrant(grant: Grant): Grant {
  return grant.graph === true
    ? freezeDeep({ ...grant, portable: true })
    : grant;
}

/**
 * Every grant the subject may reach, once per membership that holds all of
 * its scoped roles, so a client can check that membership's tenant, team or
 * resource. A scoped role held only globally reaches nothing.
 */
export function collectSnapshotGrants(
  policy: Policy,
  subject: Subject,
  customRoles: readonly CustomRole[],
  now: number = nowSeconds(),
  customGrants: readonly CustomGrant[] = customGrantsFor(policy, customRoles),
  mode: "held" | "not-entitled" = "held",
): readonly { readonly grant: Grant; readonly membership?: Membership }[] {
  const skip = (grant: Grant, match: GranteeMatch): boolean =>
    mode === "held"
      ? !match.matched
      : match.matched ||
        match.reason !== "not-entitled" ||
        grant.effect !== "allow";
  const scopes = scopeList(policy.scopes);
  const declared = declaredRoleNames(policy);
  const global = expandRoleNames(
    subject.principal?.roles ?? [],
    declared,
    customRoles,
    subject.principal?.tenant,
  );
  const held = (subject.principal?.memberships ?? []).map((membership) => ({
    membership,
    roles: new Set(
      expandRoleNames(
        membership.roles,
        declared,
        customRoles,
        tenantOf(membership, scopes),
      ).roles,
    ),
  }));
  // No cascade: a scoped role counts only on a membership of its own scope.
  const holds = (
    entry: (typeof held)[number],
    item: { readonly role: string; readonly scope: Grant["scope"] },
  ): boolean =>
    entry.roles.has(item.role) &&
    (typeof item.scope === "string"
      ? entry.membership.scope === item.scope
      : entry.membership.on !== undefined);
  const out: { readonly grant: Grant; readonly membership?: Membership }[] = [];
  for (const grant of grantList(policy)) {
    const resource = getResource(policy.permissions, grant.permission.resource);
    const match = matchGrantee(
      grant.to,
      subject,
      now,
      resource,
      scopes,
      policy.resources,
    );
    if (skip(grant, match)) {
      continue;
    }
    const roleItems = flattenGrantee(grant.to).filter(
      (item) => item.kind === "role",
    );
    if (roleItems.length > 0 && subject.principal === null) {
      continue;
    }
    const globalOk = roleItems.every(
      (item) => item.scope !== "global" || global.roles.includes(item.role),
    );
    if (!globalOk) {
      continue;
    }
    const merged: Grant = graphAware(grant, match.where);
    const scoped = roleItems.filter((item) => item.scope !== "global");
    if (scoped.length === 0) {
      out.push({ grant: merged });
      continue;
    }
    for (const entry of held) {
      if (scoped.every((item) => item.kind === "role" && holds(entry, item))) {
        out.push({ grant: merged, membership: entry.membership });
      }
    }
  }
  for (const { grant, role } of customGrants) {
    const globalHeld = holdsGlobalCustomRole(subject.principal?.roles, role);
    const holders = held.filter((entry) =>
      holdsCustomRole(entry.membership, role, scopes),
    );
    if (holders.length === 0 && !globalHeld) {
      continue;
    }
    const resource = getResource(policy.permissions, grant.permission.resource);
    const match = matchGrantee(
      grant.to,
      subject,
      now,
      resource,
      scopes,
      policy.resources,
    );
    if (skip(grant, match)) {
      continue;
    }
    const merged: Grant = graphAware(grant, match.where);
    if (globalHeld) {
      out.push({ grant: merged });
    }
    for (const entry of holders) {
      out.push({ grant: merged, membership: entry.membership });
    }
  }
  const fresh = policy.fresh ?? [];
  if (mode === "held" && subject.stale === true && fresh.length > 0) {
    return out.filter(
      ({ grant }) =>
        grant.effect === "deny" || !fresh.includes(grant.permission.key),
    );
  }
  return out;
}

/**
 * Declared roles a tenant admin may hand out or compose, before any
 * intersection: `assignable` roles, plus every role some `assigns` lists.
 */
function assignableCandidates(policy: Policy): readonly Role[] {
  const listed = new Set(
    policy.roles.flatMap((binding) => binding.assigns ?? []),
  );
  const names = [
    ...listRoles(policy.vocabulary?.roles)
      .filter((leaf) => leaf.assignable || listed.has(leaf.key))
      .map((leaf) => leaf.key),
    ...policy.roles
      .filter((binding) => binding.assignable || listed.has(binding.name))
      .map((binding) => binding.name),
  ];
  return rankRoles(policy, [...new Set(names)]).map((name) =>
    roleLeaf(policy, name),
  );
}

export type Assignable = {
  readonly roles: readonly Role[];
  readonly permissions: readonly Permission[];
  /** Per assignable permission key with levels, the levels the subject may hand out. */
  readonly levels: Readonly<Record<string, readonly string[]>>;
  /** A `meta.manageRoles` role or permission lifted the intersection. */
  readonly manage: boolean;
  /** Custom roles held at a scope the subject assigns at that allow nothing: never offered, still revocable. */
  readonly inert: readonly string[];
};

/**
 * The levels a held allow of a permission covers: its own `level`, every
 * level when it has no row condition, or the levels whose condition equals
 * its condition.
 */
function heldLevels(
  policy: Policy,
  grant: Grant,
  names: readonly string[],
): readonly string[] {
  if (grant.level !== undefined) {
    return [grant.level];
  }
  if (grant.where === undefined) {
    return names;
  }
  const held = canonicalJson(grant.where);
  return names.filter((name) => {
    const condition = levelCondition(policy, grant.permission.resource, name);
    return condition !== undefined && canonicalJson(condition) === held;
  });
}

/**
 * What the subject may hand out in `tenant`: declared assignable roles and the
 * tenant custom-role ceiling, narrowed by `allowed` (`RoleSource.assignable`),
 * then intersected with the permissions the subject holds there. Holding a
 * role or a granted permission with `meta.manageRoles` lifts the intersection.
 */
function assignableIn(
  policy: Policy,
  subject: Subject,
  customRoles: readonly CustomRole[],
  customGrants: readonly CustomGrant[],
  tenant: string | undefined,
  allowed: readonly string[] | undefined,
  now: number = nowSeconds(),
  global = false,
): Assignable {
  const principal = subject.principal;
  if (principal === null) {
    return { roles: [], permissions: [], levels: {}, manage: false, inert: [] };
  }
  const scopes = scopeList(policy.scopes);
  const scoped: Subject =
    tenant === undefined
      ? subject
      : freezeDeep(
          compact<Subject>({
            ...subject,
            principal: compact<Principal>({
              ...principal,
              tenant: resolveActiveTenant(principal, tenant, scopes, now),
            }),
          }),
        );
  const heldGrants = collectSnapshotGrants(
    policy,
    scoped,
    customRoles,
    now,
    customGrants,
  )
    .filter(
      (item) =>
        item.grant.effect === "allow" &&
        (item.membership === undefined ||
          (!global &&
            tenantOf(item.membership, scopes) === tenant &&
            !isMembershipExpired(item.membership, now))),
    )
    .map((item) => item.grant);
  const heldKeys = new Set(heldGrants.map((grant) => grant.permission.key));
  const heldNames = heldRoleNames(policy, subject, tenant, undefined, now);
  const quiet: EvalEnv = {
    emit: false,
    simulated: true,
    skipAlternatives: true,
    customRoles,
    customGrants,
    listeners: emptyListeners(),
    sink: undefined,
    limits: undefined,
    limitCache: new Map(),
    team: undefined,
  };
  const manage =
    heldNames.some((name) => roleMeta(policy, name)?.manageRoles === true) ||
    listPermissions(policy.permissions).some(
      (leaf) =>
        leaf.meta.manageRoles === true &&
        evaluate(
          policy,
          scoped,
          leaf,
          undefined,
          { source: "simulate", trusted: true, now },
          quiet,
        ).outcome === "granted",
    );
  const narrowed = allowed === undefined ? undefined : new Set<string>(allowed);
  const candidates = assignableCandidates(policy).filter(
    (leaf) => narrowed === undefined || narrowed.has(leaf.key),
  );
  const held = new Set(heldNames);
  // An `assigns` graph is authoritative: held roles hand out exactly what they list.
  const listed = usesAssigns(policy)
    ? new Set(
        heldNames.flatMap(
          (name) => policy.rolesByName.get(name)?.assigns ?? [],
        ),
      )
    : undefined;
  const roles = manage
    ? candidates
    : candidates.filter((leaf) => {
        if (listed !== undefined) {
          return listed.has(leaf.key);
        }
        if (held.has(leaf.key)) {
          return true;
        }
        // A role with no allows yet may gain hosted grants later: only its holders assign it.
        const keys = [...roleAllowKeys(policy, leaf.key)];
        return keys.length > 0 && keys.every((key) => heldKeys.has(key));
      });
  const root = global ? "global" : rootScope(scopes);
  const ceiling = new Set(
    (root === undefined ? [] : ceilingGrants(policy, root, allowed)).map(
      (grant) => grant.permission.key,
    ),
  );
  const permissions = listPermissions(policy.permissions).filter(
    (leaf) => ceiling.has(leaf.key) && (manage || heldKeys.has(leaf.key)),
  );
  const offeredLevels = (
    key: string,
    names: readonly string[],
  ): readonly string[] => {
    if (manage) {
      return names;
    }
    const reached = new Set(
      heldGrants
        .filter((grant) => grant.permission.key === key)
        .flatMap((grant) => heldLevels(policy, grant, names)),
    );
    return names.filter((name) => reached.has(name));
  };
  const levels: Record<string, readonly string[]> = {};
  for (const leaf of permissions) {
    const names =
      leaf.kind === "instance" ? levelNames(policy, leaf.resource) : [];
    if (names.length > 0) {
      levels[leaf.key] = offeredLevels(leaf.key, names);
    }
  }
  const ceilingKeys = new Map<string, ReadonlySet<string>>();
  const mayHandOut = (scope: string, grant: Grant): boolean => {
    const key = grant.permission.key;
    let keys = ceilingKeys.get(scope);
    if (keys === undefined) {
      keys = new Set(
        ceilingGrants(policy, scope, allowed).map(
          (item) => item.permission.key,
        ),
      );
      ceilingKeys.set(scope, keys);
    }
    if (!keys.has(key) || !(manage || heldKeys.has(key))) {
      return false;
    }
    const names =
      grant.permission.kind === "instance"
        ? levelNames(policy, grant.permission.resource)
        : [];
    if (names.length === 0) {
      return true;
    }
    const offered = offeredLevels(key, names);
    return heldLevels(policy, grant, names).every((name) =>
      offered.includes(name),
    );
  };
  const custom =
    global || tenant === undefined
      ? { roles: [], inert: [] }
      : assignableCustomRoles(
          policy,
          customRoles,
          tenant,
          manage ? undefined : roles,
          mayHandOut,
        );
  return {
    roles: [...roles, ...custom.roles],
    permissions,
    levels,
    manage,
    inert: custom.inert,
  };
}

/**
 * The tenant's custom roles the subject may hand out: held at a scope it may
 * assign declared roles at (any scope with `meta.manageRoles`), allowing at
 * least one permission after the ceiling, and only permissions and levels it
 * may hand out at that scope. A role that allows nothing is `inert`.
 */
function assignableCustomRoles(
  policy: Policy,
  customRoles: readonly CustomRole[],
  tenant: string,
  declared: readonly Role[] | undefined,
  mayHandOut: (scope: string, grant: Grant) => boolean,
): { readonly roles: readonly Role[]; readonly inert: readonly string[] } {
  const scopes = scopeList(policy.scopes);
  const root = rootScope(scopes);
  const assignsAt =
    declared === undefined
      ? undefined
      : new Set(
          declared.map((leaf) =>
            leaf.on === undefined ? root : resolveScope(scopes, leaf.on),
          ),
        );
  const out = new Map<string, Role>();
  const inert = new Set<string>();
  for (const role of tenantCustomRoles(policy, customRoles)) {
    if (role.tenant !== tenant || out.has(role.name)) {
      continue;
    }
    const at = customRoleScope(role, scopes);
    if (at === undefined || (assignsAt !== undefined && !assignsAt.has(at))) {
      continue;
    }
    const { grants } = resolveCustomRole(policy, role);
    if (!grants.some((grant) => grant.effect === "allow")) {
      inert.add(role.name);
      continue;
    }
    const within = grants.every(
      (grant) => grant.effect === "deny" || mayHandOut(at, grant),
    );
    if (within) {
      out.set(
        role.name,
        synthesiseRole(role.name, { on: at, assignable: true }),
      );
    }
  }
  return {
    roles: [...out.values()].toSorted((a, b) => a.key.localeCompare(b.key)),
    inert: [...inert].filter((name) => !out.has(name)).toSorted(),
  };
}

export type SnapshotInclude = readonly (
  | Permission
  | { readonly [key: string]: unknown }
)[];

/** The one path from a resolved subject to a `Snapshot`; pure apart from the default clock. */
export function snapshotOf(
  policy: Policy,
  subject: Subject,
  options: {
    readonly customRoles: readonly CustomRole[];
    readonly customGrants?: readonly CustomGrant[];
    /** Role names `RoleSource.assignable` returned, per tenant. */
    readonly assignable?: ReadonlyMap<string, readonly string[]>;
    readonly include?: SnapshotInclude;
    readonly tenants?: "all";
    readonly simulated?: boolean;
    readonly now?: number;
  },
): Snapshot {
  const now = options.now ?? nowSeconds();
  const customGrants =
    options.customGrants ?? customGrantsFor(policy, options.customRoles);
  const roles = heldRoleNames(
    policy,
    subject,
    subject.principal?.tenant,
    undefined,
    now,
  );
  const audiences = audiencesOf(policy, roles);
  return buildSnapshot(
    compact<Parameters<typeof buildSnapshot>[0]>({
      subject,
      roles,
      audiences: audiences.length === 0 ? undefined : audiences,
      notEntitled: collectSnapshotGrants(
        policy,
        subject,
        options.customRoles,
        now,
        customGrants,
        "not-entitled",
      ),
      grants: collectSnapshotGrants(
        policy,
        subject,
        options.customRoles,
        now,
        customGrants,
      ).map((item) =>
        periodBound(policy, item.grant)
          ? Object.assign({}, item, {
              grant: freezeDeep({ ...item.grant, portable: false }),
            })
          : item,
      ),
      include: includePrefixes(options.include),
      tenants: options.tenants,
      simulated: options.simulated,
      now: Math.floor(now),
      vocabulary: policy.vocabulary,
      scopes: snapshotScopes(policy),
      delegated: delegatedPermissions(
        policy.delegations,
        subject,
        new Set(roles),
        now,
      ),
      assignable: (tenant: string) => {
        const found = assignableIn(
          policy,
          subject,
          options.customRoles,
          customGrants,
          tenant,
          options.assignable?.get(tenant),
          now,
        );
        return compact<SnapshotAssignable>({
          tenant,
          roles: found.roles.map((leaf) => leaf.key),
          permissions: found.permissions,
          levels:
            Object.keys(found.levels).length === 0 ? undefined : found.levels,
        });
      },
    }),
  );
}

/** The policy's scopes as snapshots and `permdock cloud push` carry them, with the resources each partitions. */
export function snapshotScopes(policy: Policy): Snapshot["scopes"] {
  if (policy.scopes.length === 0) {
    return undefined;
  }
  const resources = [...policy.resources.values()];
  return policy.scopes.map((scope) => {
    const partitioned = resources
      .filter((node) => partitionsOf(node, policy.scopes).includes(scope.name))
      .map((node) => node.name);
    return compact<NonNullable<Snapshot["scopes"]>[number]>({
      name: scope.name,
      key: scope.key ?? "",
      within: scope.within,
      resources: partitioned.length === 0 ? undefined : partitioned,
    });
  });
}

export function buildInstance(
  policy: Policy,
  subject: Subject,
  envBase: {
    readonly customRoles: readonly CustomRole[];
    readonly sink: DecisionSink | undefined;
    readonly limits: LimitStore | undefined;
    readonly limitCache: Map<string, number>;
    readonly simulated: boolean;
    readonly roleSource: RoleSource | undefined;
    /** `RoleSource.assignable` per tenant, loaded with the custom roles. */
    readonly assignable?: ReadonlyMap<string, readonly string[]>;
    readonly queuedAuth: readonly AuthEvent[];
    /** Errors from building the instance (a dropped hosted grant), replayed to `on('error')`. */
    readonly queuedErrors?: readonly unknown[];
    readonly relations?: RelationSource;
    /** Relation facts read so far; shared by the instances `tenant()`, `team()` and `simulate()` derive. */
    readonly relationCache?: RelationCache;
    /** The membership source, for `whoCan`'s member lists. */
    readonly memberships?: MembershipSource;
    /** `ApprovalPolicySource` entries, loaded once with the instance. */
    readonly approvalPolicies?: LoadedApprovalPolicies;
  },
  team?: string,
): PermDock {
  const listeners = emptyListeners();
  const queuedAuth = [...envBase.queuedAuth];
  const queuedErrors = [...(envBase.queuedErrors ?? [])];
  const customGrants = customGrantsFor(policy, envBase.customRoles);
  const relationCache: RelationCache = envBase.relationCache ?? new Map();
  const relations = relationReader(
    envBase.relations,
    relationCache,
    policy.resources,
  );
  const assignableAt = (tenant: string | undefined): Assignable =>
    assignableIn(
      policy,
      subject,
      envBase.customRoles,
      customGrants,
      tenant,
      tenant === undefined ? undefined : envBase.assignable?.get(tenant),
    );
  const envFor = (emit: boolean, skipAlternatives = false): EvalEnv => ({
    emit,
    simulated: envBase.simulated,
    skipAlternatives,
    customRoles: envBase.customRoles,
    customGrants,
    listeners,
    sink: envBase.sink,
    limits: envBase.limits,
    limitCache: envBase.limitCache,
    team,
    relations,
    ...(envBase.approvalPolicies === undefined
      ? {}
      : { approvalPolicies: envBase.approvalPolicies }),
  });

  /** The one `simulate` event for a batch: the worst decision, with the counts. */
  const simulateEvent = (
    evaluated: readonly (readonly [Permission, unknown, Decision])[],
  ): void => {
    const counts = { granted: 0, denied: 0, approvalRequired: 0 };
    for (const [, , decision] of evaluated) {
      if (decision.outcome === "granted") {
        counts.granted += 1;
      } else if (decision.outcome === "approval-required") {
        counts.approvalRequired += 1;
      } else {
        counts.denied += 1;
      }
    }
    const worst =
      evaluated.find(([, , decision]) => decision.outcome === "denied") ??
      evaluated.find(
        ([, , decision]) => decision.outcome === "approval-required",
      ) ??
      evaluated[0];
    if (worst === undefined) {
      return;
    }
    const [permission, data, decision] = worst;
    finish(
      policy,
      subject,
      permission,
      data,
      decision,
      { source: "simulate", trusted: true },
      { ...envFor(false), emit: true },
      true,
      undefined,
      counts,
    );
  };

  const decideImpl = (
    permission: Permission,
    data?: unknown,
    options?: DecideOptions,
  ): Decision =>
    evaluate(
      policy,
      subject,
      permission,
      data,
      options ?? {},
      envFor(options?.source !== "simulate", options?.source === "can"),
    );

  const explainImpl = (
    permission: Permission,
    data?: unknown,
    options?: Omit<DecideOptions, "explain">,
  ): ExplainedDecision => {
    const decision = decideImpl(permission, data, {
      ...options,
      source: options?.source ?? "explain",
      explain: true,
    });
    // SAFETY: evaluate attaches a trace to every decision made with explain: true.
    return decision as ExplainedDecision;
  };

  const canImpl = (
    permission: Permission,
    data?: unknown,
    options?: DecideOptions,
  ): boolean => {
    try {
      return (
        decideImpl(permission, data, {
          ...options,
          source: options?.source ?? "can",
        }).outcome === "granted"
      );
    } catch {
      return false;
    }
  };

  const assertImpl = (
    permission: Permission,
    data?: unknown,
    options?: DecideOptions,
  ): Extract<Decision, { readonly outcome: "granted" }> => {
    const decision = decideImpl(permission, data, {
      ...options,
      source: options?.source ?? "assert",
    });
    if (decision.outcome === "granted") {
      return decision;
    }
    const onDenied = options?.onDenied ?? policy.onDenied;
    if (onDenied !== undefined) {
      onDenied(decision);
    }
    const resource = getResource(policy.permissions, permission.resource);
    // SAFETY: data is a non-null object checked in the condition; the read value stays unknown.
    const resourceId =
      data !== null && typeof data === "object"
        ? (data as Record<string, unknown>)[resource?.id ?? "id"]
        : undefined;
    const resourceRef = compact<{
      readonly type: string;
      readonly id?: string;
    }>({
      type: permission.resource,
      id: resourceId === undefined ? undefined : String(resourceId),
    });
    if (decision.outcome === "approval-required") {
      throw new PermDockApprovalRequiredError({
        decision,
        permission: permission.key,
        scope: permission.scope,
        resource: resourceRef,
        message: approvalMessage(
          permission.key,
          decision.reason,
          decision.token,
        ),
      });
    }
    if (decision.denials.some((denial) => denial.reason === "validation")) {
      const detail = decision.denials[0]?.detail;
      if (detail instanceof PermDockValidationError) {
        throw detail;
      }
    }
    throw new PermDockDeniedError({
      decision,
      permission: permission.key,
      scope: permission.scope,
      resource: resourceRef,
      subject,
      message: deniedMessage(
        permission.key,
        subject.principal?.id,
        decision.denials,
        decision.alternatives.map((leaf) => leaf.key),
      ),
    });
  };

  // SAFETY: canImpl, decideImpl, assertImpl and explainImpl each implement every overload of their member.
  const instance: PermDock = {
    can: canImpl as PermDock["can"],
    decide: decideImpl as PermDock["decide"],
    assert: assertImpl as PermDock["assert"],
    explain: explainImpl as PermDock["explain"],
    permissions: policy.permissions,
    roles: policy.vocabulary?.roles ?? {},
    plans: policy.vocabulary?.plans ?? {},
    filter<T>(
      permission: Permission<string, T, "instance">,
      rows: readonly T[],
      options?: DecideOptions,
    ): T[] {
      const allowed: T[] = [];
      let granted = 0;
      let denied = 0;
      let approvalRequired = 0;
      const quiet = envFor(false);
      const trusted = options?.trusted ?? true;
      const decideOptions: DecideOptions = {
        ...options,
        source: "filter",
        trusted,
      };
      for (const row of rows) {
        const decision = evaluate(
          policy,
          subject,
          permission,
          row,
          decideOptions,
          quiet,
        );
        if (decision.outcome === "granted") {
          allowed.push(row);
          granted += 1;
        } else if (decision.outcome === "approval-required") {
          approvalRequired += 1;
        } else {
          denied += 1;
        }
      }
      const summary: Decision =
        granted > 0
          ? freezeDeep({
              outcome: "granted",
              subject,
              matched: {
                role: "*",
                permission: permission.key,
              },
              token: "pd1.filter",
            })
          : freezeDeep({
              outcome: "denied",
              denials: [{ role: null, reason: "no-grant" }],
              alternatives: [],
            });
      finish(
        policy,
        subject,
        permission,
        rows[0],
        summary,
        decideOptions,
        { ...quiet, emit: true },
        trusted,
        undefined,
        { granted, denied, approvalRequired },
      );
      return allowed;
    },
    pick<T>(
      permission: Permission<string, T, "instance">,
      row: T,
      options?: DecideOptions,
    ): Partial<T> {
      if (row === null || typeof row !== "object") {
        return {};
      }
      if (canImpl(permission, row, options) !== true) {
        return {};
      }
      return pickVisible(row, (field) => {
        const next = compact<DecideOptions>({ ...options, field });
        return canImpl(permission, row, next) === true;
      });
    },
    where(permission: Permission): WhereResult {
      const grants = collectSnapshotGrants(
        policy,
        subject,
        envBase.customRoles,
        nowSeconds(),
        customGrants,
      )
        .filter((item) => item.grant.permission.key === permission.key)
        .map((item) => snapshotGrant(whereGrant(item.grant), item.membership));
      return whereFromGrants(
        grants,
        compact({
          resource: permission.resource,
          resources: policy.resources,
          graph: envBase.relations !== undefined,
          scopes: scopeList(policy.scopes),
          partitioned: (name: string, key: string) =>
            relatesTo(
              getResource(policy.permissions, permission.resource),
              key,
              name,
              scopeList(policy.scopes),
            ),
          tenant: subject.principal?.tenant,
          team,
          now: nowSeconds(),
          subject,
        }),
      );
    },
    actions(
      resource: Permission | { readonly [key: string]: unknown },
      data: unknown,
      options?: DecideOptions,
    ): Permission[] {
      // SAFETY: actions takes a leaf or a resource node, the shapes listPermissions walks.
      const fromTree = listPermissions(resource as never);
      const leaves =
        fromTree.length > 0
          ? fromTree
          : "resource" in resource && typeof resource.resource === "string"
            ? listPermissions(policy.permissions).filter(
                (item) => item.resource === resource.resource,
              )
            : [];
      return leaves.filter((item) => canImpl(item, data, options) === true);
    },
    async loadRelations(
      permission: Permission,
      rows: readonly unknown[],
    ): Promise<void> {
      if (envBase.relations === undefined) {
        return;
      }
      const quiet: EvalEnv = {
        ...envFor(false),
        simulated: true,
        skipAlternatives: true,
      };
      for (let round = 0; round < LOAD_ROUNDS; round += 1) {
        for (const row of rows) {
          evaluate(
            policy,
            subject,
            permission,
            row,
            { source: "simulate", trusted: true },
            quiet,
          );
        }
        const pending = pendingRelations(relationCache);
        if (pending.length === 0) {
          return;
        }
        // oxlint-disable-next-line no-await-in-loop -- each round's reads depend on the answers of the one before
        await Promise.all(pending);
      }
    },
    whoCan(permission: Permission, row: unknown) {
      return whoCan({
        policy,
        permission,
        row,
        memberships: envBase.memberships,
        reader: relations,
        cache: relationCache,
        customGrants,
        team,
      });
    },
    // SAFETY: the implementation returns the result type of each simulate overload for its input.
    simulate: ((
      input:
        | readonly (readonly [Permission, unknown?])[]
        | {
            readonly roles?: readonly (string | Role)[];
            readonly memberships?: readonly Membership[];
            readonly tenant?: string;
          }
        | ArazzoSimulateInput,
      options?: SimulateOptions,
    ): Decision[] | PermDock | ArazzoPlan => {
      const evaluated: (readonly [Permission, unknown, Decision])[] = [];
      const quietly = (permission: Permission, data: unknown): Decision => {
        const decision = evaluate(
          policy,
          subject,
          permission,
          data,
          compact<DecideOptions>({
            source: "simulate",
            trusted: true,
            now: options?.now,
          }),
          envFor(false),
        );
        evaluated.push([permission, data, decision]);
        return decision;
      };
      if (isReadonlyArray(input)) {
        const decisions = input.map(([permission, data]) =>
          quietly(permission, data),
        );
        simulateEvent(evaluated);
        return decisions;
      }
      if (isArazzoSimulateInput(input)) {
        const plan = simulateArazzo(
          input,
          input.permissions ?? policy.permissions,
          quietly,
        );
        simulateEvent(evaluated);
        return plan;
      }
      // SAFETY: arrays and Arazzo input returned above, so the rest of the union is the preview.
      const preview = input as {
        readonly roles?: readonly (string | Role)[];
        readonly memberships?: readonly Membership[];
        readonly tenant?: string;
      };
      const previewRoles = preview.roles?.map((item) =>
        typeof item === "string" ? item : item.key,
      );
      const kinds =
        subject.principal === null
          ? undefined
          : applyRoleKinds(
              policy,
              previewRoles ?? subject.principal.roles,
              preview.memberships === undefined
                ? (subject.principal.memberships ?? [])
                : normalizeMemberships(
                    preview.memberships,
                    scopeList(policy.scopes),
                  ),
            );
      const previewPrincipal =
        subject.principal === null || kinds === undefined
          ? null
          : freezeDeep(
              compact<Principal>({
                ...subject.principal,
                roles: kinds.roles,
                memberships:
                  preview.memberships === undefined &&
                  subject.principal.memberships === undefined
                    ? undefined
                    : kinds.memberships,
                tenant: preview.tenant ?? subject.principal.tenant,
              }),
            );
      const previewSubject: Subject = freezeDeep({
        ...subject,
        principal: previewPrincipal,
      });
      return buildInstance(
        policy,
        previewSubject,
        { ...envBase, simulated: true, relationCache },
        team,
      );
    }) as PermDock["simulate"],
    snapshot(options) {
      const snapshot = snapshotOf(
        policy,
        subject,
        compact<Parameters<typeof snapshotOf>[2]>({
          customRoles: envBase.customRoles,
          customGrants,
          assignable: envBase.assignable,
          include: options?.include,
          tenants: options?.tenants,
          simulated: envBase.simulated,
        }),
      );
      if (options?.signer !== undefined) {
        return signSnapshot(snapshot, options.signer, options.audience);
      }
      return snapshot;
    },
    on(event, handler) {
      // SAFETY: on() types handler by event name, so each set only receives matching handlers.
      const set = listeners[event] as Set<(payload: unknown) => void>;
      set.add(handler);
      if (event === "auth") {
        for (const queued of queuedAuth) {
          try {
            // SAFETY: event is 'auth' here, so handler is the auth handler on() was typed with.
            (handler as (payload: AuthEvent) => void)(queued);
          } catch (error) {
            emitSafe(listeners.error, error, listeners);
          }
        }
      }
      if (event === "error") {
        for (const queued of queuedErrors) {
          try {
            handler(queued);
          } catch {
            // An error handler that throws has nowhere left to report.
          }
        }
      }
      return (): void => {
        set.delete(handler);
      };
    },
    tenant(id: string): PermDock {
      if (subject.principal === null) {
        return buildInstance(
          policy,
          subject,
          { ...envBase, relationCache },
          team,
        );
      }
      const next = freezeDeep(
        compact<Subject>({
          ...subject,
          principal: compact<Principal>({
            ...subject.principal,
            tenant: resolveActiveTenant(
              subject.principal,
              id,
              scopeList(policy.scopes),
            ),
          }),
        }),
      );
      return buildInstance(policy, next, { ...envBase, relationCache }, team);
    },
    team(id: string): PermDock {
      return buildInstance(policy, subject, { ...envBase, relationCache }, id);
    },
    memberships(): readonly Membership[] {
      return subject.principal?.memberships ?? [];
    },
    tenants(): readonly string[] {
      return tenantsOf(subject.principal, scopeList(policy.scopes));
    },
    heldRoles(options?: {
      readonly tenant?: string;
      readonly scope?: string;
      readonly id?: string;
    }): readonly Role[] {
      const names = heldRoleNames(
        policy,
        subject,
        options?.tenant ?? subject.principal?.tenant,
        options?.scope === undefined
          ? undefined
          : compact({ scope: options.scope, id: options.id }),
      );
      return names.map((name) => roleLeaf(policy, name));
    },
    audiences(): readonly string[] {
      return audiencesOf(
        policy,
        heldRoleNames(policy, subject, subject.principal?.tenant),
      );
    },
    assignableRoles(options?: { readonly tenant?: string }): readonly Role[] {
      return assignableAt(options?.tenant ?? subject.principal?.tenant).roles;
    },
    assignablePermissions(options?: {
      readonly tenant?: string;
      readonly scope?: "global";
    }): readonly Permission[] {
      if (options?.scope === "global") {
        return assignableIn(
          policy,
          subject,
          envBase.customRoles,
          customGrants,
          undefined,
          undefined,
          nowSeconds(),
          true,
        ).permissions;
      }
      const tenant = options?.tenant ?? subject.principal?.tenant;
      return tenant === undefined ? [] : assignableAt(tenant).permissions;
    },
    assignableLevels(
      permission: Permission,
      options?: { readonly tenant?: string; readonly scope?: "global" },
    ): readonly string[] {
      const of = (found: Assignable): readonly string[] =>
        (Object.hasOwn(found.levels, permission.key)
          ? found.levels[permission.key]
          : undefined) ?? [];
      if (options?.scope === "global") {
        return of(
          assignableIn(
            policy,
            subject,
            envBase.customRoles,
            customGrants,
            undefined,
            undefined,
            nowSeconds(),
            true,
          ),
        );
      }
      const tenant = options?.tenant ?? subject.principal?.tenant;
      return tenant === undefined ? [] : of(assignableAt(tenant));
    },
    decideRoleChange(
      change: RoleChange,
      options?: RoleChangeOptions,
    ): RoleChangeDecision {
      return decideRoleChange(
        policy,
        subject.principal,
        scopeList(policy.scopes),
        change,
        envBase.customRoles,
        (tenant) => {
          const found = assignableAt(tenant);
          return {
            assignable: new Set(found.roles.map((leaf) => leaf.key)),
            manage: found.manage,
            inert: new Set(found.inert),
          };
        },
        nowSeconds(),
        options,
      );
    },
    activate(input: ActivateInput): Decision {
      return activate(policy, subject, input, nowSeconds());
    },
    derive(options: DeriveOptions): PermDock | Promise<PermDock> {
      const scopes = scopeList(policy.scopes);
      const tenants = tenantsOf(subject.principal, scopes);
      const auth: AuthEvent[] = [];
      const roleSource = options.customRoles ?? envBase.roleSource;
      const roles =
        options.customRoles === undefined
          ? envBase.customRoles
          : customRolesFor(
              options.customRoles,
              tenants,
              auth,
              subject.principal !== null,
              (tenant) => heldRoleNamesIn(subject.principal, scopes, tenant),
            );
      const names =
        options.customRoles === undefined
          ? envBase.assignable
          : assignableNamesFor(options.customRoles, tenants, auth);
      const approvals =
        options.approvalPolicies === undefined
          ? envBase.approvalPolicies
          : approvalPoliciesFor(
              policy,
              options.approvalPolicies,
              tenants,
              auth,
            );
      const relationSource = options.relations ?? envBase.relations;
      const build = (
        loadedRoles: readonly CustomRole[],
        loadedNames: ReadonlyMap<string, readonly string[]> | undefined,
        loadedApprovals: LoadedApprovalPolicies | undefined,
      ): PermDock =>
        buildInstance(
          policy,
          subject,
          compact<Parameters<typeof buildInstance>[2]>({
            ...envBase,
            customRoles: loadedRoles,
            roleSource,
            assignable: loadedNames,
            approvalPolicies: loadedApprovals,
            relations: relationSource,
            relationCache:
              options.relations === undefined ? relationCache : undefined,
            queuedAuth: auth,
            queuedErrors: [],
          }),
          team,
        );
      if (isThenable(roles) || isThenable(names) || isThenable(approvals)) {
        return Promise.all([roles, names, approvals]).then(
          ([loadedRoles, loadedNames, loadedApprovals]) =>
            build(loadedRoles, loadedNames, loadedApprovals),
        );
      }
      return build(roles, names, approvals);
    },
    subject,
  };
  return Object.freeze(instance);
}
