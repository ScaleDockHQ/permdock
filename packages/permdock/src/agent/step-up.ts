import type { Decision, DenialReason } from "../core/decision.ts";
import type { PermDock } from "../core/permdock.ts";
import type { Permission } from "../core/permission-types.ts";
import type { Membership } from "../core/subject.ts";

import { compact } from "../core/compact.ts";
import { activate } from "../core/elevated.ts";
import { delegationAllows } from "../core/may-use.ts";
import { stepUpOf } from "../core/problem-details.ts";
import { isMembershipExpired, nowSeconds } from "../core/tenancy.ts";

/**
 * What the user can do to lift a denial: authenticate again with the `acr`
 * and `maxAge` the failing grants ask for, or activate a role they are
 * eligible for. A hint for the user; the call is decided again afterwards.
 */
export type StepUp =
  | {
      readonly kind: "authentication";
      readonly acrValues?: readonly string[];
      readonly maxAge?: number;
    }
  | {
      readonly kind: "activation";
      readonly role: string;
      readonly scope: string;
      readonly id: string;
      readonly within?: Readonly<Record<string, string>>;
    };

/** Denials neither a fresh sign-in nor an activation can lift. */
const FINAL: ReadonlySet<DenialReason> = new Set<DenialReason>([
  "deny",
  "validation",
  "anonymous",
  "not-delegated",
  "no-delegation",
  "agent-tool-not-delegated",
  "approval",
  "stale-approval",
]);

/** Activation denials the activation flow itself asks the user to fix. */
const ACTIVATION_ASKS: ReadonlySet<DenialReason> = new Set<DenialReason>([
  "reason-required",
  "insufficient-user-authentication",
]);

function elevated(
  membership: Membership & { readonly scope: string; readonly id: string },
  role: string,
): Membership {
  return compact<Membership>({
    scope: membership.scope,
    id: membership.id,
    within: membership.within,
    roles: [role],
    via: "elevated",
  });
}

function activationFor(
  permdock: PermDock,
  permission: Permission,
  data: unknown,
): StepUp | undefined {
  const held = permdock.subject.principal?.memberships ?? [];
  const now = nowSeconds();
  for (const membership of held) {
    const { scope, id } = membership;
    if (
      scope === undefined ||
      id === undefined ||
      isMembershipExpired(membership, now)
    ) {
      continue;
    }
    for (const role of membership.eligible ?? []) {
      const offered = activate(
        permdock,
        compact({ role, scope, id, within: membership.within }),
      );
      if (
        offered.outcome === "denied" &&
        !offered.denials.every((denial) => ACTIVATION_ASKS.has(denial.reason))
      ) {
        continue;
      }
      const [decision] = permdock
        .simulate({
          memberships: [...held, elevated({ ...membership, scope, id }, role)],
        })
        .simulate([[permission, data]]);
      if (decision !== undefined && decision.outcome !== "denied") {
        return compact<StepUp>({
          kind: "activation",
          role,
          scope,
          id,
          within: membership.within,
        });
      }
    }
  }
  return undefined;
}

/**
 * The step-up that could lift `decision`, or `undefined`. A denial with
 * `insufficient-user-authentication` asks for a fresh sign-in when the
 * delegation and the actor still cover the permission; any other
 * denial asks for the first eligible role whose activation the simulated
 * decision grants. A matched deny, a validation failure, an anonymous
 * subject, a delegation that does not cover the call, an undelegated tool
 * and a failed approval resume never step up.
 */
export function stepUpFor(
  permdock: PermDock,
  permission: Permission,
  data: unknown,
  decision: Decision,
): StepUp | undefined {
  if (
    decision.outcome !== "denied" ||
    decision.denials.length === 0 ||
    decision.denials.some((denial) => FINAL.has(denial.reason))
  ) {
    return undefined;
  }
  try {
    if (
      decision.denials.some(
        (denial) => denial.reason === "insufficient-user-authentication",
      )
    ) {
      return delegationAllows(permdock, permission)
        ? { kind: "authentication", ...stepUpOf(decision) }
        : undefined;
    }
    return activationFor(permdock, permission, data);
  } catch {
    return undefined;
  }
}

/**
 * The subject's instance with every eligible role activated, for a tool
 * listing that keeps tools an activation would open. `undefined` when the
 * subject is eligible for nothing.
 */
export function eligiblePreview(permdock: PermDock): PermDock | undefined {
  const held = permdock.subject.principal?.memberships ?? [];
  const now = nowSeconds();
  const activations = held.flatMap((membership) => {
    const { scope, id } = membership;
    return scope === undefined ||
      id === undefined ||
      isMembershipExpired(membership, now)
      ? []
      : (membership.eligible ?? []).map((role) =>
          elevated({ ...membership, scope, id }, role),
        );
  });
  if (activations.length === 0) {
    return undefined;
  }
  try {
    return permdock.simulate({ memberships: [...held, ...activations] });
  } catch {
    return undefined;
  }
}

/** The URL the user signs in again at, with the RFC 9470 `acr_values` and `max_age` added. */
function signInUrl(at: string, stepUp: StepUp): string | undefined {
  if (stepUp.kind !== "authentication") {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(at);
  } catch {
    return undefined;
  }
  if (stepUp.acrValues !== undefined && stepUp.acrValues.length > 0) {
    url.searchParams.set("acr_values", stepUp.acrValues.join(" "));
  }
  if (stepUp.maxAge !== undefined) {
    url.searchParams.set("max_age", String(stepUp.maxAge));
  }
  return url.href;
}

/** The sentence the user reads on the step-up prompt. */
export function stepUpText(
  stepUp: StepUp,
  permission: Permission,
  at: string | undefined,
): string {
  switch (stepUp.kind) {
    case "authentication": {
      const url = at === undefined ? undefined : signInUrl(at, stepUp);
      return url === undefined
        ? `Sign in again to use ${permission.key}.`
        : `Sign in again to use ${permission.key}: ${url}`;
    }
    case "activation":
      return `Activate the ${stepUp.role} role on ${stepUp.scope} ${stepUp.id} to use ${permission.key}.`;
    default: {
      const exhaustive: never = stepUp;
      return exhaustive;
    }
  }
}
