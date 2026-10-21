import type { AuthEvent } from "../event-types.ts";
import type { Scope } from "../scopes.ts";
import type { ResourceRoleWalk } from "../tenancy.ts";
import type { EvaluationCall, HeldRoles, Rows } from "./state.ts";

import { actorRequiredVias, isSupportMembership } from "../elevated.ts";
import { emitSafe } from "../events.ts";
import { resourceRoleCondition } from "../grantee-conditions.ts";
import { resolveRelated } from "../relation-walk.ts";
import { expandRoleNames } from "../role-loading.ts";
import { isRowPair } from "../row-pair.ts";
import { tenantOf } from "../scopes.ts";
import { inTeam, isMembershipExpired } from "../tenancy.ts";
import { PermDockValidationError } from "../validation-error.ts";
import { validateBoundary } from "../validation.ts";

/**
 * The rows after boundary validation; on `invalid`, the rows validated before
 * the failure.
 */
export function validatedRows(
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

export function heldRoles(
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
  const denials: HeldRoles["denials"] = [];
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
export function lacksActor(
  call: EvaluationCall,
  scopes: readonly Scope[],
): boolean {
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

export function walkRoleFor(
  call: EvaluationCall,
): ResourceRoleWalk | undefined {
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
