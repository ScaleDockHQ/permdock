import type {
  Decision,
  Denial,
  DenialReason,
  GrantedDecision,
  MatchedGrant,
  Obligation,
} from "./decision.ts";
import type { AuthEvent } from "./event-types.ts";
import type { DecideOptions } from "./permdock.ts";
import type { Permission, ResourceNode } from "./permission-types.ts";
import type { Grant, Policy } from "./policy-types.ts";
import type { CustomRole, Membership, Subject } from "./subject.ts";

import {
  APPROVAL_POLICY_UNAVAILABLE,
  decisionTenant,
  tightenApproval,
} from "./approval-policies.ts";
import { compact } from "./compact.ts";
import { contactAllows } from "./contact.ts";
import {
  holdsCustomRole,
  holdsGlobalCustomRole,
  isGlobalCustomRole,
} from "./custom-roles.ts";
import {
  coveredByDelegation,
  coversRequirements,
  delegatedPermissions,
  requiresStandIn,
} from "./delegation.ts";
import {
  actorRequiredVias,
  evaluateBreakGlass,
  isSupportMembership,
  purposesOf,
} from "./elevated.ts";
import {
  alternativesFor,
  inheritedVerdict,
} from "./evaluation-alternatives.ts";
import { type Tracer, skip, traceOf } from "./evaluation-trace.ts";
import { type EvalEnv, emitSafe, finish } from "./events.ts";
import { grantCoversField } from "./fields.ts";
import { freezeDeep } from "./freeze.ts";
import {
  evaluateGrantCondition,
  isDelegatedPermission,
  isUnevaluable,
  matchedOf,
  shouldConsumeQuota,
} from "./grant-conditions.ts";
import { resourceRoleCondition } from "./grantee-conditions.ts";
import { combineWhere, matchGrantee } from "./grantee-match.ts";
import { flattenGrantee } from "./grantee.ts";
import { applyQuota } from "./limits.ts";
import { getResource } from "./permission-registry.ts";
import { declaredRoleNames, requiresApproval } from "./policy.ts";
import { resolveRelated } from "./relation-walk.ts";
import { requirementCondition } from "./requires-conditions.ts";
import { resourceIdOf } from "./resource-ref.ts";
import { expandRoleNames } from "./role-loading.ts";
import { isRowPair, rowIdOf, rowValues } from "./row-pair.ts";
import {
  type Scope,
  scopeList,
  subjectForPermission,
  tenantOf,
} from "./scopes.ts";
import {
  inTeam,
  isMembershipExpired,
  matchScopedMembership,
  type ResourceRoleWalk,
} from "./tenancy.ts";
import { epochSeconds, INVALID_NOW } from "./time.ts";
import { decisionToken, payloadDigest, versionOf } from "./token.ts";
import { PermDockValidationError } from "./validation-error.ts";
import { validateBoundary } from "./validation.ts";
import { isActive, wireValidity } from "./validity.ts";

type ScopeMatch = ReturnType<typeof matchScopedMembership>;

/**
 * A collection write proposes `next`; an update pair may move `next` out of
 * the scope `current` is in. Both must stay in scope.
 */
function matchWriteScope(
  match: (row: unknown) => ScopeMatch,
  instance: boolean,
  current: unknown,
  next: unknown,
): ScopeMatch {
  const first = match(instance ? current : next);
  if (!first.ok || !instance || next === current) {
    return first;
  }
  const moved = match(next);
  return moved.ok ? first : moved;
}

type Rows = { readonly current: unknown; readonly next: unknown };

type Allow = {
  readonly grant: Grant;
  readonly membership?: Membership;
  readonly obligations?: readonly Obligation[];
  readonly breakGlass?: true;
};

type Candidate = { readonly grant: Grant; readonly custom?: CustomRole };

type BreakGlass = {
  readonly grant: Grant | undefined;
  readonly obligations: readonly Obligation[];
  readonly overrides: ReadonlySet<string>;
  readonly denial: Denial | undefined;
};

type HeldRoles = {
  readonly global: ReturnType<typeof expandRoleNames>;
  readonly matching: ReadonlySet<string>;
  readonly denials: Denial[];
};

/** The inputs every phase of one `evaluate` call reads. */
type EvaluationCall = {
  readonly policy: Policy;
  readonly given: Subject;
  readonly subject: Subject;
  readonly permission: Permission;
  readonly options: DecideOptions;
  readonly env: EvalEnv;
  readonly now: number;
  readonly resource: ResourceNode | undefined;
  readonly tracer: Tracer | undefined;
};

/** One call after validation: its rows, held roles, and the denials and allows the grant phases collect. */
type EvaluationState = EvaluationCall &
  Rows & {
    readonly scopes: readonly Scope[];
    readonly declared: ReadonlySet<string>;
    readonly roles: HeldRoles;
    readonly purposes: readonly string[];
    readonly walkRole: ResourceRoleWalk | undefined;
    readonly denials: Denial[];
    readonly allows: Allow[];
  };

function complete(
  call: EvaluationCall & { readonly current: unknown },
  raw: Decision,
  membership?: Membership,
): Decision {
  const { env, permission, tracer } = call;
  const decision: Decision =
    env.outcomeOnly !== true &&
    raw.outcome === "denied" &&
    raw.permission === undefined
      ? { ...raw, permission: permission.key }
      : raw;
  const final: Decision =
    env.outcomeOnly === true
      ? decision
      : freezeDeep(
          tracer === undefined
            ? decision
            : { ...decision, trace: traceOf(tracer) },
        );
  finish(
    call.policy,
    call.given,
    permission,
    call.current,
    final,
    call.options,
    env,
    call.options.trusted === true,
    membership,
  );
  return final;
}

function deniedNow(
  call: EvaluationCall & { readonly current: unknown },
  denial: Denial,
): Decision {
  return complete(call, {
    outcome: "denied",
    denials: [denial],
    alternatives: [],
  });
}

function deniedWithAlternatives(
  state: EvaluationState,
  denials: readonly Denial[],
): Decision {
  return complete(state, {
    outcome: "denied",
    denials,
    alternatives: state.env.skipAlternatives
      ? []
      : alternativesFor(
          evaluate,
          state.policy,
          state.permission,
          state.subject,
          state.now,
          state.env,
        ),
  });
}

/** The rows after boundary validation; on `invalid`, the rows validated before the failure. */
function validatedRows(
  call: EvaluationCall,
  data: unknown,
  rows: Rows,
): Rows & { readonly invalid?: PermDockValidationError } {
  const { permission, policy, options } = call;
  if (
    data === undefined &&
    !(permission.kind === "instance" && policy.validate === "always")
  ) {
    return rows;
  }
  const check = (value: unknown): unknown =>
    validateBoundary(
      permission,
      call.resource,
      value,
      policy.validate,
      options.trusted === true,
      options.boundary ?? "manual",
    );
  let current = rows.current;
  try {
    if (permission.kind === "instance" && isRowPair(data)) {
      current = check(data.current);
      return { current, next: check(data.next) };
    }
    const validated = check(data);
    return permission.kind === "instance"
      ? { current: validated, next: validated }
      : { current, next: validated };
  } catch (error) {
    if (
      error instanceof PermDockValidationError &&
      error.code === "invalid-data"
    ) {
      return { current, next: rows.next, invalid: error };
    }
    throw error;
  }
}

function heldRoles(
  call: EvaluationCall,
  scopes: readonly Scope[],
  declared: ReadonlySet<string>,
): HeldRoles {
  const { subject, env } = call;
  const global = expandRoleNames(
    subject.principal?.roles ?? [],
    declared,
    env.customRoles,
    subject.principal?.tenant,
  );
  if (subject.principal !== null && global.unknown.length > 0) {
    // SAFETY: emitSafe passes these listeners only the AuthEvent literal below.
    emitSafe(
      env.listeners.auth as unknown as Set<(payload: unknown) => void>,
      { reason: "unknown-role", source: "roles" } satisfies AuthEvent,
      env.listeners,
    );
  }
  const matching = new Set<string>(global.roles);
  const denials: Denial[] = [];
  for (const membership of subject.principal?.memberships ?? []) {
    if (!inTeam(membership, scopes, env.team)) {
      continue;
    }
    const expanded = expandRoleNames(
      membership.roles,
      declared,
      env.customRoles,
      tenantOf(membership, scopes),
    );
    for (const name of expanded.roles) {
      matching.add(name);
    }
    for (const name of expanded.unknown) {
      denials.push({ role: name, reason: "unknown-role" });
    }
  }
  return { global, matching, denials };
}

/** A support membership the policy says needs an actor, held without one. */
function lacksActor(call: EvaluationCall, scopes: readonly Scope[]): boolean {
  const { subject, now, env } = call;
  const actorVias = actorRequiredVias(call.policy.index.supports);
  return (
    actorVias.size > 0 &&
    subject.actor === undefined &&
    (subject.principal?.memberships ?? []).some(
      (membership) =>
        isSupportMembership(membership, actorVias) &&
        !isMembershipExpired(membership, now) &&
        inTeam(membership, scopes, env.team),
    )
  );
}

function candidatesFor(call: EvaluationCall): Candidate[] {
  const { permission } = call;
  const candidates: Candidate[] = (
    call.policy.index.grantsByKey.get(permission.key) ?? []
  )
    .filter((grant) => grant.breakGlass === undefined)
    .map((grant) => ({ grant }));
  for (const item of call.env.customGrants) {
    if (item.grant.permission.key === permission.key) {
      candidates.push({ grant: item.grant, custom: item.role });
    }
  }
  return candidates;
}

function breakGlassFor(
  call: EvaluationCall,
  scopes: readonly Scope[],
): BreakGlass {
  const { permission, subject, now, tracer } = call;
  const overrides = new Set<string>();
  let denial: Denial | undefined;
  for (const grant of call.policy.index.grantsByKey.get(permission.key) ?? []) {
    if (grant.breakGlass === undefined) {
      continue;
    }
    if (tracer !== undefined) {
      tracer.evaluated += 1;
    }
    if (!matchGrantee(grant.to, subject, now, call.resource, scopes).matched) {
      skip(tracer, grant, permission.key, "grantee");
      continue;
    }
    const result = evaluateBreakGlass(grant.breakGlass, subject, now);
    if (result.kind === "inactive") {
      skip(tracer, grant, permission.key, "break-glass-inactive");
      continue;
    }
    for (const name of grant.breakGlass.overrides) {
      overrides.add(name);
    }
    if (result.kind === "granted") {
      return { grant, obligations: result.obligations, overrides, denial };
    }
    denial ??=
      result.reason === "insufficient-user-authentication"
        ? { role: null, reason: result.reason, to: result.to }
        : { role: null, reason: result.reason };
  }
  return { grant: undefined, obligations: [], overrides, denial };
}

function walkRoleFor(call: EvaluationCall): ResourceRoleWalk | undefined {
  const { env } = call;
  if (env.relations?.available !== true) {
    return undefined;
  }
  return (membership, row) => {
    const on = membership.on;
    const condition =
      on === undefined
        ? undefined
        : resourceRoleCondition(
            call.resource,
            on.resource,
            [on.id],
            call.policy.resources,
          );
    return condition === undefined || env.relations === undefined
      ? false
      : resolveRelated(condition, row, call.subject, call.now, env.relations);
  };
}

function holdsCustom(state: EvaluationState, custom: CustomRole): boolean {
  return isGlobalCustomRole(custom)
    ? holdsGlobalCustomRole(state.subject.principal?.roles ?? [], custom)
    : (state.subject.principal?.memberships ?? []).some(
        (membership) =>
          inTeam(membership, state.scopes, state.env.team) &&
          holdsCustomRole(membership, custom, state.scopes),
      );
}

function holdsRole(
  state: EvaluationState,
  item: { readonly role: string; readonly scope: unknown },
  custom: CustomRole | undefined,
): boolean {
  if (custom !== undefined) {
    return holdsCustom(state, custom);
  }
  return item.scope === "global"
    ? state.roles.global.roles.includes(item.role)
    : state.roles.matching.has(item.role);
}

/**
 * Whether the subject holds every role the grantee names, at a scope the row
 * (and a write's next row) is in. `held: false` when a denial or skip was recorded.
 */
function roleScope(
  state: EvaluationState,
  grant: Grant,
  custom: CustomRole | undefined,
):
  | { readonly held: true; readonly membership?: Membership }
  | { readonly held: false } {
  const { subject, permission, tracer } = state;
  const roleItems = flattenGrantee(grant.to).filter(
    (item) => item.kind === "role",
  );
  if (roleItems.length === 0) {
    return { held: true };
  }
  if (subject.principal === null) {
    state.denials.push({ role: grant.role, reason: "anonymous" });
    return { held: false };
  }
  let membership: Membership | undefined;
  for (const roleItem of roleItems) {
    if (!holdsRole(state, roleItem, custom)) {
      skip(tracer, grant, permission.key, "role");
      return { held: false };
    }
    const matchRow = (row: unknown): ScopeMatch =>
      matchScopedMembership(
        subject,
        roleItem.scope,
        roleItem.role,
        row,
        state.scopes,
        state.resource,
        state.policy.resources,
        state.now,
        (held) => {
          if (custom === undefined) {
            return expandRoleNames(
              held.roles,
              state.declared,
              state.env.customRoles,
              tenantOf(held, state.scopes),
            ).roles;
          }
          return holdsCustomRole(held, custom, state.scopes)
            ? [custom.name]
            : [];
        },
        state.env.team,
        state.walkRole,
        permission.kind === "instance",
        state.options.scope,
      );
    const scopeMatch = matchWriteScope(
      matchRow,
      permission.kind === "instance",
      state.current,
      state.next,
    );
    if (!scopeMatch.ok) {
      state.denials.push({ role: roleItem.role, reason: scopeMatch.reason });
      return { held: false };
    }
    membership = scopeMatch.membership ?? membership;
  }
  return membership === undefined ? { held: true } : { held: true, membership };
}

/** Whether the grantee matches; records the denial or skip when it does not. */
function granteeOf(
  state: EvaluationState,
  grant: Grant,
  custom: CustomRole | undefined,
): ReturnType<typeof matchGrantee> | undefined {
  const { subject, now, permission } = state;
  if (
    grant.viaOnly !== undefined &&
    !(subject.principal?.memberships ?? []).some(
      (membership) =>
        membership.via === grant.viaOnly &&
        !isMembershipExpired(membership, now) &&
        inTeam(membership, state.scopes, state.env.team),
    )
  ) {
    skip(state.tracer, grant, permission.key, "via-only");
    return undefined;
  }
  const required = grant.purpose;
  if (
    required !== undefined &&
    !state.purposes.some((purpose) => required.includes(purpose))
  ) {
    skip(state.tracer, grant, permission.key, "purpose");
    return undefined;
  }
  // A deny whose grantee kind is unknown applies to everyone: unknown denies.
  const granteeMatch = matchGrantee(
    grant.to,
    subject,
    now,
    state.resource,
    state.scopes,
    state.policy.resources,
    grant.effect === "deny",
  );
  if (granteeMatch.matched) {
    return granteeMatch;
  }
  const reason = granteeMatch.reason ?? "no-grant";
  if (
    reason === "not-entitled" &&
    !flattenGrantee(grant.to).every(
      (item) => item.kind !== "role" || holdsRole(state, item, custom),
    )
  ) {
    skip(state.tracer, grant, permission.key, "grantee");
    return undefined;
  }
  state.denials.push(
    (reason === "insufficient-user-authentication" ||
      reason === "not-entitled") &&
      grant.to !== undefined
      ? { role: grant.role, reason, to: grant.to }
      : { role: grant.role, reason },
  );
  return undefined;
}

/** One candidate grant: records an allow, a denial or a skip, or returns the decision a deny ends with. */
function evaluateCandidate(
  state: EvaluationState,
  { grant, custom }: Candidate,
  breakGlass: BreakGlass,
): Decision | undefined {
  const { policy, subject, permission, now, env, tracer } = state;
  const displayRole = grant.role;
  if (tracer !== undefined) {
    tracer.evaluated += 1;
  }
  const granteeMatch = granteeOf(state, grant, custom);
  if (granteeMatch === undefined) {
    return undefined;
  }
  const scoped = roleScope(state, grant, custom);
  if (!scoped.held) {
    return undefined;
  }
  if (!isActive(grant.validity, now)) {
    if (grant.effect === "allow") {
      state.denials.push({
        role: displayRole,
        reason: "inactive-grant",
        detail: wireValidity(grant.validity) ?? {},
      });
    } else {
      skip(tracer, grant, permission.key, "validity");
    }
    return undefined;
  }
  const requirement =
    grant.requires === undefined || grant.effect !== "allow"
      ? undefined
      : requirementCondition(
          policy,
          subject,
          grant.requires,
          state.resource,
          now,
          env.customRoles,
          env.customGrants,
        );
  const merged: Grant = freezeDeep(
    compact({
      ...grant,
      where: combineWhere(
        combineWhere(grant.where, granteeMatch.where),
        requirement,
      ),
    }),
  );
  const condition = evaluateGrantCondition(
    merged,
    permission,
    state.current,
    state.next,
    subject,
    now,
    state.scopes,
    env.relations,
    (target, id, key) =>
      inheritedVerdict(
        evaluate,
        policy,
        state.given,
        target,
        id,
        key,
        now,
        env,
      ),
  );
  if (!condition.matched && condition.reason === "closure-error") {
    emitSafe(
      env.listeners.error,
      condition.cause ?? new Error("closure-error"),
      env.listeners,
    );
  }
  if (
    !condition.matched &&
    grant.effect === "deny" &&
    isUnevaluable(condition.reason) &&
    grantCoversField(grant.fields, state.options.field, grant.effect)
  ) {
    tracer?.denies.push(matchedOf(merged, permission.key));
    return deniedNow(state, {
      role: displayRole,
      reason: condition.reason ?? "relation-unavailable",
    });
  }
  if (!condition.matched) {
    state.denials.push({
      role: displayRole,
      reason: condition.reason ?? "condition",
      detail: condition.cause,
    });
    return undefined;
  }
  if (!grantCoversField(grant.fields, state.options.field, grant.effect)) {
    skip(tracer, grant, permission.key, "field");
    return undefined;
  }
  if (grant.effect === "deny") {
    tracer?.denies.push(matchedOf(merged, permission.key));
    if (grant.name !== undefined && breakGlass.overrides.has(grant.name)) {
      if (breakGlass.grant !== undefined) {
        return undefined;
      }
      if (breakGlass.denial !== undefined) {
        return deniedWithAlternatives(state, [breakGlass.denial]);
      }
    }
    return deniedWithAlternatives(state, [
      grant.name === undefined
        ? { role: displayRole, reason: "deny" }
        : { role: displayRole, reason: "deny", detail: { name: grant.name } },
    ]);
  }
  tracer?.allows.push(matchedOf(merged, permission.key));
  state.allows.push(
    scoped.membership === undefined
      ? { grant: merged }
      : { grant: merged, membership: scoped.membership },
  );
  return undefined;
}

function noAllowDecision(state: EvaluationState): Decision {
  const { denials, subject, roles } = state;
  const reason: DenialReason =
    denials[0]?.reason ??
    (subject.principal === null
      ? "anonymous"
      : roles.global.unknown.length > 0 && roles.global.roles.length === 0
        ? "unknown-role"
        : "no-grant");
  return deniedWithAlternatives(
    state,
    denials.length > 0 ? denials : [{ role: null, reason }],
  );
}

/**
 * The allows a delegation leaves usable. A policy delegation is a ceiling for
 * the actor: outside it, nothing is delegated; inside it, a token delegation
 * on the call must still cover.
 */
function delegatedAllows(state: EvaluationState): Allow[] | Decision {
  const { policy, subject, permission, current } = state;
  const ceiling = delegatedPermissions(
    policy.delegations,
    subject,
    state.roles.matching,
    state.now,
  );
  if (ceiling !== undefined && !ceiling.has(permission.key)) {
    return deniedWithAlternatives(state, [
      { role: null, reason: "not-delegated" },
    ]);
  }
  const unscoped = subject.actor !== undefined && ceiling === undefined;
  let delegationMiss = coveredByDelegation(
    permission,
    subject.delegation,
    resourceIdOf(current),
    unscoped,
  );
  const requirementsCovered = state.allows.filter((candidate) =>
    coversRequirements(
      policy.permissions,
      candidate.grant.requires,
      subject.delegation,
      resourceIdOf(current),
      unscoped,
    ),
  );
  const usable =
    delegationMiss === undefined
      ? requirementsCovered
      : requirementsCovered.filter((candidate) =>
          requiresStandIn(candidate.grant),
        );
  if (delegationMiss === "not-delegated" && usable.length > 0) {
    delegationMiss = undefined;
  }
  if (delegationMiss === undefined && usable.length === 0) {
    delegationMiss = "not-delegated";
  }
  if (delegationMiss !== undefined) {
    return deniedWithAlternatives(state, [
      { role: null, reason: delegationMiss },
    ]);
  }
  return usable;
}

function approvalOf(
  state: EvaluationState,
  candidate: Allow,
): Grant["approval"] {
  const approvalPolicies = state.env.approvalPolicies;
  return approvalPolicies === undefined || approvalPolicies === "failed"
    ? candidate.grant.approval
    : tightenApproval(candidate.grant.approval, approvalPolicies, {
        permission: state.permission.key,
        tenant: decisionTenant(state.subject, candidate.membership),
        subject: state.subject,
        current: state.current,
        next: state.next,
        now: state.now,
        scopes: state.scopes,
      });
}

type QuotaState = Pick<GrantedDecision, "quota" | "obligations">;

/** The first usable allow whose quota admits the call, or the quota denials. */
function quotaAllow(
  state: EvaluationState,
  usable: readonly Allow[],
):
  | {
      readonly allow: Allow;
      readonly approval: Grant["approval"];
      readonly quota: QuotaState;
    }
  | { readonly denials: readonly Denial[] } {
  const { subject, env } = state;
  const denials: Denial[] = [];
  for (const candidate of usable) {
    const approval = approvalOf(state, candidate);
    const quota = applyQuota({
      store: env.limits,
      cache: env.limitCache,
      grant: candidate.grant,
      permissionKey: state.permission.key,
      subjectId: subject.principal?.id ?? "",
      tenant: subject.principal?.tenant,
      now: state.now,
      consume:
        !requiresApproval(approval) &&
        shouldConsumeQuota(state.options.call, env.simulated),
    });
    if (quota.ok) {
      return {
        allow: candidate,
        approval,
        quota: compact({ quota: quota.quota, obligations: quota.obligations }),
      };
    }
    denials.push(
      quota.reason === "limit"
        ? { role: candidate.grant.role, reason: "limit", detail: quota.detail }
        : { role: candidate.grant.role, reason: quota.reason },
    );
  }
  return { denials };
}

function allowedDecision(
  state: EvaluationState,
  allow: Allow,
  approval: Grant["approval"],
  quotaState: QuotaState,
): Decision {
  const { policy, subject, permission, resource, env, current, next } = state;
  const resourceId =
    permission.kind === "collection" ? "*" : rowIdOf(current, resource?.id);
  const version =
    approval !== undefined &&
    approval !== "human" &&
    approval.staleOn === "resource-change" &&
    resource?.version !== undefined
      ? versionOf(current, resource.version)
      : undefined;
  const token = env.simulated
    ? "pd1.simulated"
    : env.outcomeOnly === true
      ? "pd1.outcome"
      : decisionToken({
          key: permission.key,
          resourceId,
          principal: subject.principal,
          actor: subject.actor,
          fingerprint: policy.fingerprint,
          version,
          payload:
            resourceId === "*" && (next ?? current) !== undefined
              ? payloadDigest(next ?? current)
              : undefined,
        });
  const matched = compact<MatchedGrant>({
    ...matchedOf(allow.grant, permission.key, allow.breakGlass),
    approval,
  });
  const obligations = [
    ...(quotaState.obligations ?? []),
    ...(allow.obligations ?? []),
    ...(allow.grant.obligations ?? []),
  ];
  return complete(
    state,
    requiresApproval(approval)
      ? {
          outcome: "approval-required",
          grant: matched,
          reason: "human",
          token,
        }
      : {
          outcome: "granted",
          subject,
          matched,
          token,
          ...quotaState,
          ...(obligations.length === 0 ? {} : { obligations }),
        },
    allow.membership,
  );
}

export function evaluate(
  policy: Policy,
  given: Subject,
  permission: Permission,
  data: unknown,
  options: DecideOptions,
  env: EvalEnv,
): Decision {
  const call: EvaluationCall = {
    policy,
    given,
    subject: subjectForPermission(given, permission.key),
    permission,
    options,
    env,
    now: epochSeconds(options.now),
    resource: getResource(policy.permissions, permission.resource),
    tracer:
      options.explain === true
        ? { evaluated: 0, allows: [], denies: [], skipped: [] }
        : undefined,
  };
  if (!Number.isFinite(call.now)) {
    return deniedNow(
      { ...call, now: epochSeconds(), current: data },
      { role: null, reason: "validation", detail: INVALID_NOW },
    );
  }
  const rows = validatedRows(call, data, rowValues(permission, data));
  if (rows.invalid !== undefined) {
    return deniedNow(
      { ...call, current: rows.current },
      { role: null, reason: "validation", detail: rows.invalid },
    );
  }
  const settled = { ...call, current: rows.current };
  if (isDelegatedPermission(policy, permission)) {
    return deniedNow(settled, {
      role: null,
      reason: "pdp-unavailable",
      detail: "use permdock/pdp createPermDock",
    });
  }

  const scopes = scopeList(policy.scopes);
  const declared = declaredRoleNames(policy);
  const roles = heldRoles(call, scopes, declared);
  if (lacksActor(call, scopes)) {
    return deniedNow(settled, { role: null, reason: "actor-required" });
  }
  const state: EvaluationState = {
    ...call,
    current: rows.current,
    next: rows.next,
    scopes,
    declared,
    roles,
    purposes: purposesOf(call.subject),
    walkRole: walkRoleFor(call),
    denials: roles.denials,
    allows: [],
  };
  const candidates = candidatesFor(call);
  const breakGlass = breakGlassFor(call, scopes);
  for (const candidate of candidates) {
    const decision = evaluateCandidate(state, candidate, breakGlass);
    if (decision !== undefined) {
      return decision;
    }
  }

  if (breakGlass.grant !== undefined) {
    state.tracer?.allows.push(
      matchedOf(breakGlass.grant, permission.key, true),
    );
    state.allows.push({
      grant: breakGlass.grant,
      obligations: breakGlass.obligations,
      breakGlass: true,
    });
  } else if (breakGlass.denial !== undefined) {
    state.denials.unshift(breakGlass.denial);
  }
  if (state.allows.length === 0) {
    return noAllowDecision(state);
  }
  if (
    state.subject.stale === true &&
    (policy.fresh ?? []).includes(permission.key)
  ) {
    return deniedNow(state, { role: null, reason: "stale-credentials" });
  }

  const delegated = delegatedAllows(state);
  if (!Array.isArray(delegated)) {
    return delegated;
  }
  const usable = contactAllows(policy, state.subject, permission, delegated);
  if (usable.length === 0) {
    return deniedWithAlternatives(state, [
      { role: null, reason: "not-delegated" },
    ]);
  }
  if (env.approvalPolicies === "failed" && usable.length > 0) {
    return deniedNow(state, {
      role: null,
      reason: "approval",
      detail: APPROVAL_POLICY_UNAVAILABLE,
    });
  }
  const chosen = quotaAllow(state, usable);
  if ("denials" in chosen) {
    return deniedWithAlternatives(
      state,
      chosen.denials.length > 0 ? chosen.denials : state.denials,
    );
  }
  return allowedDecision(state, chosen.allow, chosen.approval, chosen.quota);
}
