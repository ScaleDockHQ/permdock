import type { Obligation, Decision, Denial, DenialReason } from "./decision.ts";
import type { AssuranceGrantee } from "./grantee.ts";
import type { Permission, PermissionTree } from "./permissions.ts";
import type { Grant, Policy, SupportSpec } from "./policy.ts";
import type { AssuranceRequirement } from "./policy.ts";
import type { Scope } from "./scopes.ts";
import type { Membership, Subject } from "./subject.ts";
import type { Role } from "./vocabulary.ts";

import { canonicalJson } from "./canonical-json.ts";
import { compact, isReadonlyArray, sole } from "./compact.ts";
import { parseDuration } from "./duration.ts";
import { freezeDeep } from "./freeze.ts";
import { asGrantee, assurance, authenticated } from "./grantee.ts";
import { listPermissions } from "./permissions.ts";
import {
  type BreakGlassOptions,
  type BreakGlassSpec,
  type RoleBinding,
  type SupportAccessOptions,
  normalizeAssurance,
  role,
} from "./policy.ts";
import { resolveScope, scopeList } from "./scopes.ts";
import { isMembershipExpired, nowSeconds } from "./tenancy.ts";
import { decisionToken } from "./token.ts";
import { isRole } from "./vocabulary.ts";

function flattenPermissions(
  input: Permission | readonly Permission[] | PermissionTree,
): Permission[] {
  if (
    input !== null &&
    typeof input === "object" &&
    "key" in input &&
    "action" in input
  ) {
    // SAFETY: a permission leaf carries key and action; a tree node does not.
    return [input as Permission];
  }
  if (isReadonlyArray(input)) {
    return input.flatMap((item) => flattenPermissions(item));
  }
  // SAFETY: leaves and arrays returned above, so the remaining input is a PermissionTree.
  return [...listPermissions(input as PermissionTree)];
}

/**
 * The only deny override: a break-glass grant overrides deny grants whose
 * `name` it lists, and nothing else. It is an allow that stays non-portable
 * (RLS never compiles it) and grants only once its `requires` are met.
 */
export function breakGlass<T>(
  permission: Permission<string, T> | readonly Permission<string, T>[],
  options: BreakGlassOptions = {},
): Omit<Grant, "role" | "scope"> | Omit<Grant, "role" | "scope">[] {
  const purpose =
    options.requires?.purpose === undefined ||
    options.requires.purpose.length === 0
      ? undefined
      : Object.freeze([...new Set(options.requires.purpose)]);
  const spec: BreakGlassSpec = compact<BreakGlassSpec>({
    overrides: Object.freeze([...new Set(options.overrides ?? [])]),
    purpose,
    reason: options.requires?.reason === true,
    assurance: normalizeAssurance(options.requires?.assurance),
    maxDuration: options.maxDuration,
    obligations: Object.freeze([...new Set(options.obligations ?? [])]),
  });
  const grants = flattenPermissions(permission).map((leaf) =>
    freezeDeep(
      compact<Omit<Grant, "role" | "scope">>({
        permission: leaf,
        effect: "allow",
        to: authenticated(),
        portable: false,
        breakGlass: spec,
      }),
    ),
  );
  return sole(grants) ?? grants;
}

/**
 * Support access with tenant consent: a role a vendor holds only through a
 * consented, time-bound `via: 'support'` membership. `actorRequired` denies
 * every decision under it without an `act`; `forbid` compiles to deny grants
 * scoped to `via: 'support'`.
 */
export function supportAccess<const S extends string>(
  options: SupportAccessOptions<S> & { readonly on: S },
): RoleBinding<S>;
/** Support access held in the `tenant` scope. */
export function supportAccess(
  options: SupportAccessOptions<never>,
): RoleBinding<"tenant">;
export function supportAccess(options: SupportAccessOptions): RoleBinding {
  const via = options.role;
  const forbidden = (options.forbid ?? []).flatMap((item) =>
    flattenPermissions(item),
  );
  const binding = role(options.role, [], {
    on: options.on ?? "tenant",
    for: [via],
  });
  const denies = forbidden.map((leaf) =>
    freezeDeep(
      compact<Grant>({
        permission: leaf,
        effect: "deny",
        to: authenticated(),
        role: options.role,
        scope: "global",
        viaOnly: via,
        portable: false,
      }),
    ),
  );
  const support: SupportSpec = freezeDeep(
    compact<SupportSpec>({
      role: options.role,
      actorRequired: options.actorRequired === true,
      consent: {
        by: asGrantee(options.consent.by),
        durations: Object.freeze([...new Set(options.consent.durations)]),
      },
      group: options.group ?? "vendor-support",
    }),
  );
  return freezeDeep({
    ...binding,
    grants: [...binding.grants, ...denies],
    support,
  });
}

/** Whether the subject's authentication is fresh enough for an elevated grant. */
function assuranceMet(
  requirement: AssuranceRequirement | undefined,
  subject: Subject,
  now: number,
): boolean {
  if (requirement === undefined) {
    return true;
  }
  const held = subject.principal?.assurance;
  if (requirement.acr !== undefined && requirement.acr.length > 0) {
    const acr = held?.acr;
    if (acr === undefined || !requirement.acr.includes(acr)) {
      return false;
    }
  }
  if (requirement.amr !== undefined && requirement.amr.length > 0) {
    const amr = held?.amr ?? [];
    if (!requirement.amr.every((method) => amr.includes(method))) {
      return false;
    }
  }
  if (requirement.maxAge !== undefined) {
    const authTime = held?.authTime;
    if (authTime === undefined || now - authTime > requirement.maxAge) {
      return false;
    }
  }
  return true;
}

/** `context.purpose` as a list of strings; fail-closed to empty. */
export function purposesOf(subject: Subject): readonly string[] {
  const value = subject.context["purpose"];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : typeof value === "string" && value !== ""
      ? [value]
      : [];
}

export type BreakGlassResult =
  | { readonly kind: "inactive" }
  | { readonly kind: "granted"; readonly obligations: readonly Obligation[] }
  | {
      readonly kind: "denied";
      readonly reason: "purpose" | "reason-required";
    }
  | {
      readonly kind: "denied";
      readonly reason: "insufficient-user-authentication";
      readonly to: AssuranceGrantee;
    };

/**
 * Whether a break-glass grant fires for this subject. It engages when the
 * caller asserts a purpose (`context.purpose`); once engaged, an unlisted
 * purpose, a missing reason or stale authentication denies with the matching
 * reason, and everything met grants with the declared obligations.
 */
export function evaluateBreakGlass(
  spec: BreakGlassSpec,
  subject: Subject,
  now: number,
): BreakGlassResult {
  const purposes = purposesOf(subject);
  if (purposes.length === 0) {
    return { kind: "inactive" };
  }
  const required = spec.purpose;
  if (
    required !== undefined &&
    !purposes.some((purpose) => required.includes(purpose))
  ) {
    return { kind: "denied", reason: "purpose" };
  }
  const reason = subject.context["reason"];
  if (spec.reason && (typeof reason !== "string" || reason === "")) {
    return { kind: "denied", reason: "reason-required" };
  }
  if (
    spec.assurance !== undefined &&
    !assuranceMet(spec.assurance, subject, now)
  ) {
    return {
      kind: "denied",
      reason: "insufficient-user-authentication",
      to: assurance(spec.assurance),
    };
  }
  const obligations: Obligation[] = [
    ...spec.obligations.map((kind): Obligation => ({ kind })),
    ...(typeof reason === "string" && reason !== ""
      ? [{ kind: "justify" as const, reason }]
      : []),
  ];
  return { kind: "granted", obligations };
}

/** Support memberships (`via: 'support'`) the subject holds that demand an actor. */
export function actorRequiredVias(
  supports: readonly SupportSpec[],
): ReadonlySet<string> {
  return new Set(
    supports.filter((spec) => spec.actorRequired).map((spec) => spec.role),
  );
}

/** Whether a membership is a support membership of one of the given kinds. */
export function isSupportMembership(
  membership: Membership,
  vias: ReadonlySet<string>,
): boolean {
  return membership.via !== undefined && vias.has(membership.via);
}

/**
 * Whether the caller's `within` names the same ancestors as the eligible
 * membership. Omitted means "whatever the membership holds"; any entry that
 * disagrees, or names an ancestor the membership lacks, refuses.
 */
function withinAgrees(
  scopes: readonly Scope[],
  held: Readonly<Record<string, string>> | undefined,
  requested: Readonly<Record<string, string>> | undefined,
): boolean {
  if (requested === undefined) {
    return true;
  }
  return Object.entries(requested).every(([key, id]) => {
    const name = resolveScope(scopes, key) ?? key;
    return held !== undefined && Object.hasOwn(held, name) && held[name] === id;
  });
}

export type ActivateInput = {
  readonly role: string | Role;
  /** The scope the activation applies in (a declared name or the `tenant` / `team` alias). */
  readonly scope: string;
  readonly id: string;
  /** Ancestor scope ids, keyed by scope name, for a nested-scope activation. */
  readonly within?: Readonly<Record<string, string>>;
  /** How long the elevation lasts; capped at the role's `maxDuration`. */
  readonly duration?: string;
  readonly reason?: string;
};

function activationDenied(
  reason: DenialReason,
  to?: AssuranceGrantee,
): Decision {
  const denial: Denial =
    to === undefined ? { role: null, reason } : { role: null, reason, to };
  return freezeDeep({
    outcome: "denied",
    denials: [denial],
    alternatives: [],
  });
}

/**
 * Requests a just-in-time role activation. It never writes: a granted
 * decision carries the elevated membership under `elevation` for the app to
 * write. `approval-required` comes back first when the role's `activation`
 * sets `approval`. Fail-closed: an unknown role, an ineligible subject, a
 * missing justification or stale authentication all deny.
 */
export function activate(
  policy: Policy,
  subject: Subject,
  input: ActivateInput,
  now: number = nowSeconds(),
): Decision {
  const roleName = isRole(input.role) ? input.role.key : input.role;
  const binding = policy.rolesByName.get(roleName);
  const activation = binding?.activation;
  const principal = subject.principal;
  if (principal === null) {
    return activationDenied("anonymous");
  }
  if (binding === undefined || activation === undefined) {
    return activationDenied("unknown-role");
  }
  const scopes = scopeList(policy.scopes);
  const scope = resolveScope(scopes, input.scope) ?? input.scope;
  const eligible = (principal.memberships ?? []).find(
    (membership) =>
      membership.scope === scope &&
      membership.id === input.id &&
      !isMembershipExpired(membership, now) &&
      (membership.eligible ?? []).includes(roleName) &&
      withinAgrees(scopes, membership.within, input.within),
  );
  if (eligible === undefined) {
    return activationDenied("no-membership");
  }
  const within = eligible.within;
  if (activation.justification === "required") {
    const reason = input.reason;
    if (typeof reason !== "string" || reason === "") {
      return activationDenied("reason-required");
    }
  }
  if (
    activation.assurance !== undefined &&
    !assuranceMet(activation.assurance, subject, now)
  ) {
    return activationDenied(
      "insufficient-user-authentication",
      assurance(activation.assurance),
    );
  }
  const requested = parseDuration(input.duration);
  const cap = parseDuration(activation.maxDuration);
  const seconds =
    cap === undefined ? requested : Math.min(requested ?? cap, cap);
  const membership: Membership = freezeDeep(
    compact<Membership>({
      scope,
      id: input.id,
      within,
      roles: [roleName],
      via: "elevated",
      expiresAt: seconds === undefined ? undefined : Math.floor(now) + seconds,
      grantedBy: principal.id,
      reason: input.reason,
    }),
  );
  const token = decisionToken({
    key: `activate:${roleName}`,
    resourceId:
      within === undefined
        ? `${scope}:${input.id}`
        : `${scope}:${input.id}@${canonicalJson(within)}`,
    principal,
    actor: subject.actor,
    fingerprint: policy.fingerprint,
  });
  if (activation.approval !== undefined) {
    return freezeDeep({
      outcome: "approval-required",
      grant: { role: roleName, permission: `activate:${roleName}` },
      reason: "human",
      token,
    });
  }
  return freezeDeep({
    outcome: "granted",
    subject,
    matched: { role: roleName, permission: `activate:${roleName}` },
    token,
    elevation: membership,
  });
}
