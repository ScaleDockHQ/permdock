import type { Decision, Denial } from "../decision.ts";
import type { Grant } from "../policy-types.ts";
import type { Scope } from "../scopes.ts";
import type { CustomRole, Membership } from "../subject.ts";
import type {
  BreakGlass,
  Candidate,
  EvaluationCall,
  EvaluationState,
} from "./state.ts";

import { compact } from "../compact.ts";
import {
  holdsCustomRole,
  holdsGlobalCustomRole,
  isGlobalCustomRole,
} from "../custom-roles.ts";
import { evaluateBreakGlass } from "../elevated.ts";
import { inheritedVerdict } from "../evaluation-alternatives.ts";
import { skip } from "../evaluation-trace.ts";
import { emitSafe } from "../events.ts";
import { grantCoversField } from "../fields.ts";
import { freezeDeep } from "../freeze.ts";
import {
  evaluateGrantCondition,
  isUnevaluable,
  matchedOf,
} from "../grant-conditions.ts";
import { combineWhere, matchGrantee } from "../grantee-match.ts";
import { flattenGrantee } from "../grantee.ts";
import { requirementCondition } from "../requires-conditions.ts";
import { expandRoleNames } from "../role-loading.ts";
import { tenantOf } from "../scopes.ts";
import {
  inTeam,
  isMembershipExpired,
  matchScopedMembership,
} from "../tenancy.ts";
import { isActive, wireValidity } from "../validity.ts";
import { deniedNow, deniedWithAlternatives } from "./complete.ts";

type ScopeMatch = ReturnType<typeof matchScopedMembership>;

/**
 * A collection write proposes `next`; an update pair may move `next` out of the
 * scope `current` is in. An allow needs both in scope; a deny applies when
 * either is, so a move into or out of its scope stays denied.
 */
function matchWriteScope(
  match: (row: unknown) => ScopeMatch,
  instance: boolean,
  current: unknown,
  next: unknown,
  deny: boolean,
): ScopeMatch {
  const first = match(instance ? current : next);
  if (!instance || next === current) {
    return first;
  }
  if (deny) {
    return first.ok ? first : match(next);
  }
  if (!first.ok) {
    return first;
  }
  const moved = match(next);
  return moved.ok ? first : moved;
}

/**
 * The code grants and custom-role grants for the permission, break-glass grants
 * aside.
 */
export function candidatesFor(call: EvaluationCall): Candidate[] {
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

export function breakGlassFor(
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
 * (and a write's next row) is in. `held: false` when a denial or skip was
 * recorded.
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
      grant.effect === "deny",
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

/**
 * One candidate grant: records an allow, a denial or a skip, or returns the
 * decision a deny ends with.
 */
export function evaluateCandidate(
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
        state.evaluate,
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

/**
 * Adds the break-glass allow, or puts its denial first, once every candidate
 * has run.
 */
export function mergeBreakGlass(
  state: EvaluationState,
  breakGlass: BreakGlass,
): void {
  if (breakGlass.grant !== undefined) {
    state.tracer?.allows.push(
      matchedOf(breakGlass.grant, state.permission.key, true),
    );
    state.allows.push({
      grant: breakGlass.grant,
      obligations: breakGlass.obligations,
      breakGlass: true,
    });
  } else if (breakGlass.denial !== undefined) {
    state.denials.unshift(breakGlass.denial);
  }
}
