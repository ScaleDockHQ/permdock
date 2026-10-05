import type { RelatedCondition } from "../conditions/ast.ts";
import type {
  Decision,
  Denial,
  DenialReason,
  GrantedDecision,
  MatchedGrant,
  Obligation,
  Trace,
  TraceSkip,
  TraceSkipReason,
} from "./decision.ts";
import type { AuthEvent, DecisionEvent, RoleSource } from "./interfaces.ts";
import type { DecideOptions, RowPair } from "./permdock.ts";
import type { Permission } from "./permissions.ts";
import type { RelationReader } from "./relations.ts";
import type { CustomRole, Membership, Subject } from "./subject.ts";

import { evaluateCondition } from "../conditions/evaluate.ts";
import { decisionTenant, tightenApproval } from "./approval-policies.ts";
import { compact } from "./compact.ts";
import {
  isCustomRoleName,
  holdsCustomRole,
  holdsGlobalCustomRole,
  isGlobalCustomRole,
} from "./custom-roles.ts";
import {
  coveredByDelegation,
  delegatedPermissions,
  resourceIdOf,
} from "./delegation.ts";
import {
  actorRequiredVias,
  evaluateBreakGlass,
  isSupportMembership,
  purposesOf,
} from "./elevated.ts";
import { PermDockValidationError } from "./errors.ts";
import { type EvalEnv, emitSafe, finish } from "./events.ts";
import { grantCoversField } from "./fields.ts";
import { freezeDeep } from "./freeze.ts";
import {
  combineWhere,
  flattenGrantee,
  matchGrantee,
  resourceRoleCondition,
} from "./grantee.ts";
import { applyQuota } from "./limits.ts";
import { getResource, listPermissions } from "./permissions.ts";
import { requiresApproval, type Grant, type Policy } from "./policy.ts";
import { resolveRelated } from "./relations.ts";
import { scopeList, tenantOf } from "./scopes.ts";
import {
  inTeam,
  isMembershipExpired,
  matchScopedMembership,
  nowSeconds,
  type ResourceRoleWalk,
} from "./tenancy.ts";
import { isThenable } from "./thenable.ts";
import { decisionToken, payloadDigest, versionOf } from "./token.ts";
import { validateBoundary } from "./validation.ts";
import { isActive } from "./validity.ts";

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

function isRowPair(value: unknown): value is RowPair<unknown> {
  return (
    value !== null &&
    typeof value === "object" &&
    "current" in value &&
    "next" in value
  );
}

function isGlobalRole(value: unknown): value is CustomRole {
  return (
    value !== null &&
    typeof value === "object" &&
    Reflect.get(value, "scope") === "global"
  );
}

function onlyGlobal(roles: unknown): CustomRole[] {
  return Array.isArray(roles) ? roles.filter(isGlobalRole) : [];
}

export function customRolesFor(
  source: RoleSource | undefined,
  tenants: readonly string[],
  auth: AuthEvent[],
  signedIn: boolean,
  heldIn: (tenant: string) => readonly string[],
): CustomRole[] | Promise<CustomRole[]> {
  if (source === undefined) {
    return [];
  }
  const loaded: (CustomRole[] | Promise<CustomRole[]>)[] = [];
  for (const tenant of tenants) {
    try {
      loaded.push(source.rolesFor(tenant, { held: heldIn(tenant) }));
    } catch {
      auth.push({ reason: "source-threw", source: "customRoles" });
      loaded.push([]);
    }
  }
  if (signedIn && source.globalRoles !== undefined) {
    try {
      const roles = source.globalRoles();
      loaded.push(
        isThenable(roles) ? roles.then(onlyGlobal) : onlyGlobal(roles),
      );
    } catch {
      auth.push({ reason: "source-threw", source: "customRoles" });
      loaded.push([]);
    }
  }
  if (loaded.some((item) => isThenable(item))) {
    return Promise.all(
      loaded.map((item) =>
        Promise.resolve(item).catch((): CustomRole[] => {
          auth.push({ reason: "source-threw", source: "customRoles" });
          return [];
        }),
      ),
    ).then((lists) => lists.flat());
  }
  // SAFETY: the branch above returns when any item is a thenable, so every item is a list.
  return (loaded as CustomRole[][]).flat();
}

function stringList(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/**
 * `RoleSource.assignable` per tenant; `undefined` when the source has no
 * `assignable`. A tenant whose call throws or answers junk assigns nothing.
 */
export function assignableNamesFor(
  source: RoleSource | undefined,
  tenants: readonly string[],
  auth: AuthEvent[],
):
  | ReadonlyMap<string, readonly string[]>
  | Promise<ReadonlyMap<string, readonly string[]>>
  | undefined {
  if (source?.assignable === undefined) {
    return undefined;
  }
  const failed = (): string[] => {
    auth.push({ reason: "source-threw", source: "customRoles" });
    return [];
  };
  const loaded = tenants.map((tenant) => {
    try {
      return source.assignable?.(tenant) ?? [];
    } catch {
      return failed();
    }
  });
  const toMap = (lists: readonly unknown[]): Map<string, readonly string[]> =>
    new Map(tenants.map((tenant, index) => [tenant, stringList(lists[index])]));
  if (loaded.some((item) => isThenable(item))) {
    return Promise.all(
      loaded.map((item) => Promise.resolve(item).catch(failed)),
    ).then(toMap);
  }
  return toMap(loaded);
}

/**
 * The declared role names among `names`. A custom role of `tenant` is known
 * but contributes no declared name: its grants are resolved separately
 * (`customGrantsFor`), bounded by the ceiling. A tenant's custom role is
 * unknown inside another tenant and for a membership without one.
 */
export function expandRoleNames(
  names: readonly string[],
  declared: ReadonlySet<string>,
  custom: readonly CustomRole[],
  tenant: string | undefined,
): { readonly roles: readonly string[]; readonly unknown: readonly string[] } {
  const resolved = new Set<string>();
  const unknown: string[] = [];
  for (const name of names) {
    if (declared.has(name)) {
      resolved.add(name);
    } else if (!isCustomRoleName(name, custom, tenant)) {
      unknown.push(name);
    }
  }
  return { roles: [...resolved], unknown };
}

export function declaredRoleNames(policy: Policy): ReadonlySet<string> {
  return policy.index.declaredRoles;
}

function alternativesFor(
  policy: Policy,
  permission: Permission,
  subject: Subject,
  now: number,
  env: EvalEnv,
): Permission[] {
  const same = listPermissions(policy.permissions).filter(
    (leaf) =>
      leaf.resource === permission.resource && leaf.key !== permission.key,
  );
  return same.filter((leaf) => {
    const decision = evaluate(
      policy,
      subject,
      leaf,
      undefined,
      { trusted: true, source: "simulate", now },
      { ...env, emit: false, skipAlternatives: true },
    );
    return decision.outcome === "granted";
  });
}

function evaluateGrantCondition(
  grant: Grant,
  permission: Permission,
  current: unknown,
  next: unknown,
  subject: Subject,
  now: number,
  scopes: Policy["scopes"],
  relations: RelationReader | undefined,
): {
  readonly matched: boolean;
  readonly reason?: DenialReason;
  readonly cause?: unknown;
} {
  // Any graph read the instance could not answer, and any opaque node, fails the
  // grant whatever the rest of the condition says, so `not` and `or` cannot
  // turn it into a match.
  let unknown:
    | "relation-depth"
    | "relation-unavailable"
    | "opaque-condition"
    | undefined;
  const onOpaque = (): void => {
    unknown ??= "opaque-condition";
  };
  const related = (condition: RelatedCondition, row: unknown): boolean => {
    if (relations === undefined) {
      unknown ??= "relation-unavailable";
      return false;
    }
    const verdict = resolveRelated(condition, row, subject, now, relations);
    if (verdict === "relation-depth" || verdict === "relation-unavailable") {
      unknown ??= verdict;
      return false;
    }
    return verdict;
  };
  if (!grant.portable && grant.closure !== undefined) {
    try {
      const result = grant.closure(next ?? current, {
        subject,
        actor: subject.actor,
        delegation: subject.delegation,
        context: subject.context,
      });
      if (isThenable(result)) {
        return { matched: false, reason: "closure-error", cause: result };
      }
      return { matched: result === true };
    } catch (error) {
      return { matched: false, reason: "closure-error", cause: error };
    }
  }
  if (grant.where !== undefined) {
    if (permission.kind === "collection") {
      return { matched: false, reason: "condition" };
    }
    if (current === undefined) {
      return { matched: false, reason: "condition" };
    }
    if (grant.where.op === "opaque" || grant.check?.op === "opaque") {
      return { matched: false, reason: "opaque-condition" };
    }
    const matched = evaluateCondition(
      grant.where,
      current,
      subject,
      now,
      scopes,
      related,
      onOpaque,
    );
    if (unknown !== undefined) {
      return { matched: false, reason: unknown };
    }
    if (!matched) {
      return { matched: false, reason: "condition" };
    }
  }
  const checkCondition =
    grant.check ?? (permission.action === "update" ? grant.where : undefined);
  if (checkCondition !== undefined) {
    if (checkCondition.op === "opaque") {
      return { matched: false, reason: "opaque-condition" };
    }
    if (next === undefined) {
      return { matched: false, reason: "condition" };
    }
    const matched = evaluateCondition(
      checkCondition,
      next,
      subject,
      now,
      scopes,
      related,
      onOpaque,
    );
    if (unknown !== undefined) {
      return { matched: false, reason: unknown };
    }
    if (!matched) {
      return { matched: false, reason: "condition" };
    }
  }
  return { matched: true };
}

/** A grant whose condition could not be answered; a deny with one denies. */
function isUnevaluable(reason: DenialReason | undefined): boolean {
  return (
    reason === "relation-depth" ||
    reason === "relation-unavailable" ||
    reason === "closure-error" ||
    reason === "opaque-condition"
  );
}

function shouldConsumeQuota(
  source: DecisionEvent["source"] | undefined,
  simulated: boolean,
): boolean {
  if (simulated) {
    return false;
  }
  switch (source) {
    case "can":
    case "filter":
    case "simulate":
    case "explain":
      return false;
    case "decide":
    case "assert":
    case "endpoint":
    case "adapter":
    case "approval":
    case undefined:
      return true;
    default: {
      const exhaustive: never = source;
      return exhaustive;
    }
  }
}

function isDelegatedPermission(
  policy: Policy,
  permission: Permission,
): boolean {
  const providers = policy.providers;
  if (providers === undefined || providers.length === 0) {
    return false;
  }
  for (const provider of providers) {
    if (provider.handles(permission)) {
      return true;
    }
  }
  return false;
}

/** The `MatchedGrant` view of a grant, shared by `matched` and the trace. */
function matchedOf(
  grant: Grant,
  permissionKey: string,
  breakGlass?: true,
): MatchedGrant {
  return compact<MatchedGrant>({
    role: grant.role,
    permission: permissionKey,
    name: grant.name,
    to: grant.to,
    where: grant.where,
    check: grant.check,
    approval: grant.approval,
    hosted: grant.hosted,
    breakGlass,
  });
}

/**
 * Collects the trace for `explain`. Absent (undefined) on a plain `decide`,
 * so a check without `explain` allocates nothing for it.
 */
type Tracer = {
  evaluated: number;
  readonly allows: MatchedGrant[];
  readonly denies: MatchedGrant[];
  readonly skipped: TraceSkip[];
};

function skip(
  tracer: Tracer | undefined,
  grant: Grant,
  permissionKey: string,
  why: TraceSkipReason,
): void {
  tracer?.skipped.push({
    role: grant.role,
    permission: permissionKey,
    effect: grant.effect,
    why,
  });
}

function traceOf(tracer: Tracer): Trace {
  return {
    evaluated: tracer.evaluated,
    allows: tracer.allows,
    denies: tracer.denies,
    skipped: tracer.skipped,
  };
}

export function evaluate(
  policy: Policy,
  subject: Subject,
  permission: Permission,
  data: unknown,
  options: DecideOptions,
  env: EvalEnv,
): Decision {
  const now = options.now ?? nowSeconds();
  const trusted = options.trusted === true;
  const resource = getResource(policy.permissions, permission.resource);
  let current: unknown = data;
  let next: unknown = data;
  const tracer: Tracer | undefined =
    options.explain === true
      ? { evaluated: 0, allows: [], denies: [], skipped: [] }
      : undefined;
  const complete = (decision: Decision, membership?: Membership): Decision => {
    const final: Decision = freezeDeep(
      tracer === undefined ? decision : { ...decision, trace: traceOf(tracer) },
    );
    finish(
      policy,
      subject,
      permission,
      current,
      final,
      options,
      env,
      trusted,
      membership,
    );
    return final;
  };
  if (permission.kind === "instance" && isRowPair(data)) {
    current = data.current;
    next = data.next;
  }
  if (permission.kind === "collection") {
    current = undefined;
    next = data;
  }
  try {
    if (
      data !== undefined ||
      (permission.kind === "instance" && policy.validate === "always")
    ) {
      const validated = validateBoundary(
        permission,
        resource,
        permission.kind === "instance" && isRowPair(data) ? data.current : data,
        policy.validate,
        trusted,
        options.boundary ?? "manual",
      );
      if (permission.kind === "instance" && isRowPair(data)) {
        current = validated;
        next = validateBoundary(
          permission,
          resource,
          data.next,
          policy.validate,
          trusted,
          options.boundary ?? "manual",
        );
      } else if (permission.kind === "instance") {
        current = validated;
        next = validated;
      } else {
        next = validated;
      }
    }
  } catch (error) {
    if (
      error instanceof PermDockValidationError &&
      error.code === "invalid-data"
    ) {
      return complete({
        outcome: "denied",
        denials: [{ role: null, reason: "validation", detail: error }],
        alternatives: [],
      });
    }
    throw error;
  }

  if (isDelegatedPermission(policy, permission)) {
    return complete({
      outcome: "denied",
      denials: [
        {
          role: null,
          reason: "pdp-unavailable",
          detail: "use permdock/pdp createPermDock",
        },
      ],
      alternatives: [],
    });
  }

  const scopes = scopeList(policy.scopes);
  const declared = declaredRoleNames(policy);
  const principalRoles = subject.principal?.roles ?? [];
  const globalNames = expandRoleNames(
    principalRoles,
    declared,
    env.customRoles,
    subject.principal?.tenant,
  );
  if (subject.principal !== null && globalNames.unknown.length > 0) {
    // SAFETY: emitSafe passes these listeners only the AuthEvent literal below.
    emitSafe(
      env.listeners.auth as unknown as Set<(payload: unknown) => void>,
      { reason: "unknown-role", source: "roles" } satisfies AuthEvent,
      env.listeners,
    );
  }

  const denials: Denial[] = [];
  const allows: {
    readonly grant: Grant;
    readonly membership?: Membership;
    readonly obligations?: readonly Obligation[];
    readonly breakGlass?: true;
  }[] = [];
  const matchingRoles = new Set<string>(globalNames.roles);

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
      matchingRoles.add(name);
    }
    for (const name of expanded.unknown) {
      denials.push({ role: name, reason: "unknown-role" });
    }
  }

  const actorVias = actorRequiredVias(policy.index.supports);
  if (
    actorVias.size > 0 &&
    subject.actor === undefined &&
    (subject.principal?.memberships ?? []).some(
      (membership) =>
        isSupportMembership(membership, actorVias) &&
        !isMembershipExpired(membership, now) &&
        inTeam(membership, scopes, env.team),
    )
  ) {
    return complete({
      outcome: "denied",
      denials: [{ role: null, reason: "actor-required" }],
      alternatives: [],
    });
  }

  const purposes = purposesOf(subject);

  const forPermission = policy.index.grantsByKey.get(permission.key) ?? [];
  const candidates: { readonly grant: Grant; readonly custom?: CustomRole }[] =
    forPermission
      .filter((grant) => grant.breakGlass === undefined)
      .map((grant) => ({ grant }));
  for (const item of env.customGrants) {
    if (item.grant.permission.key === permission.key) {
      candidates.push({ grant: item.grant, custom: item.role });
    }
  }

  let breakGlassGrant: Grant | undefined;
  let breakGlassObligations: readonly Obligation[] = [];
  const breakGlassOverrides = new Set<string>();
  let breakGlassDenial: Denial | undefined;
  for (const grant of forPermission) {
    if (grant.breakGlass === undefined) {
      continue;
    }
    if (tracer !== undefined) {
      tracer.evaluated += 1;
    }
    if (!matchGrantee(grant.to, subject, now, resource, scopes).matched) {
      skip(tracer, grant, permission.key, "grantee");
      continue;
    }
    const result = evaluateBreakGlass(grant.breakGlass, subject, now);
    if (result.kind === "inactive") {
      skip(tracer, grant, permission.key, "break-glass-inactive");
      continue;
    }
    for (const name of grant.breakGlass.overrides) {
      breakGlassOverrides.add(name);
    }
    if (result.kind === "granted") {
      breakGlassGrant = grant;
      breakGlassObligations = result.obligations;
      break;
    }
    breakGlassDenial ??=
      result.reason === "insufficient-user-authentication"
        ? { role: null, reason: result.reason, to: result.to }
        : { role: null, reason: result.reason };
  }

  const holdsCustom = (custom: CustomRole): boolean =>
    isGlobalCustomRole(custom)
      ? holdsGlobalCustomRole(principalRoles, custom)
      : (subject.principal?.memberships ?? []).some(
          (membership) =>
            inTeam(membership, scopes, env.team) &&
            holdsCustomRole(membership, custom, scopes),
        );

  const walkRole: ResourceRoleWalk | undefined =
    env.relations?.available === true
      ? (membership, row) => {
          const on = membership.on;
          const condition =
            on === undefined
              ? undefined
              : resourceRoleCondition(
                  resource,
                  on.resource,
                  [on.id],
                  policy.resources,
                );
          return condition === undefined || env.relations === undefined
            ? false
            : resolveRelated(condition, row, subject, now, env.relations);
        }
      : undefined;

  for (const { grant, custom } of candidates) {
    const displayRole = grant.role;
    if (tracer !== undefined) {
      tracer.evaluated += 1;
    }
    if (
      grant.viaOnly !== undefined &&
      !(subject.principal?.memberships ?? []).some(
        (membership) =>
          membership.via === grant.viaOnly &&
          !isMembershipExpired(membership, now) &&
          inTeam(membership, scopes, env.team),
      )
    ) {
      skip(tracer, grant, permission.key, "via-only");
      continue;
    }
    const required = grant.purpose;
    if (
      required !== undefined &&
      !purposes.some((purpose) => required.includes(purpose))
    ) {
      skip(tracer, grant, permission.key, "purpose");
      continue;
    }
    // A deny whose grantee kind is unknown applies to everyone: unknown denies.
    const granteeMatch = matchGrantee(
      grant.to,
      subject,
      now,
      resource,
      scopes,
      policy.resources,
      grant.effect === "deny",
    );
    if (!granteeMatch.matched) {
      const reason = granteeMatch.reason ?? "no-grant";
      if (
        reason === "not-entitled" &&
        !flattenGrantee(grant.to).every(
          (item) =>
            item.kind !== "role" ||
            (custom === undefined
              ? item.scope === "global"
                ? globalNames.roles.includes(item.role)
                : matchingRoles.has(item.role)
              : holdsCustom(custom)),
        )
      ) {
        skip(tracer, grant, permission.key, "grantee");
        continue;
      }
      denials.push(
        (reason === "insufficient-user-authentication" ||
          reason === "not-entitled") &&
          grant.to !== undefined
          ? { role: displayRole, reason, to: grant.to }
          : { role: displayRole, reason },
      );
      continue;
    }
    const roleItems = flattenGrantee(grant.to).filter(
      (item) => item.kind === "role",
    );
    let scopeMembership: Membership | undefined;
    let roleOk = roleItems.length === 0;
    if (roleItems.length > 0) {
      if (subject.principal === null) {
        denials.push({ role: displayRole, reason: "anonymous" });
        continue;
      }
      let allHeld = true;
      for (const roleItem of roleItems) {
        const held =
          custom === undefined
            ? roleItem.scope === "global"
              ? globalNames.roles.includes(roleItem.role)
              : matchingRoles.has(roleItem.role)
            : holdsCustom(custom);
        if (!held) {
          skip(tracer, grant, permission.key, "role");
          allHeld = false;
          break;
        }
        const matchRow = (row: unknown): ScopeMatch =>
          matchScopedMembership(
            subject,
            roleItem.scope,
            roleItem.role,
            row,
            scopes,
            resource,
            policy.resources,
            now,
            (membership) => {
              if (custom === undefined) {
                return expandRoleNames(
                  membership.roles,
                  declared,
                  env.customRoles,
                  tenantOf(membership, scopes),
                ).roles;
              }
              return holdsCustomRole(membership, custom, scopes)
                ? [custom.name]
                : [];
            },
            env.team,
            walkRole,
            permission.kind === "instance",
            options.scope,
          );
        const scopeMatch = matchWriteScope(
          matchRow,
          permission.kind === "instance",
          current,
          next,
        );
        if (!scopeMatch.ok) {
          denials.push({ role: roleItem.role, reason: scopeMatch.reason });
          allHeld = false;
          break;
        }
        scopeMembership = scopeMatch.membership ?? scopeMembership;
      }
      roleOk = allHeld;
    }
    if (!roleOk) {
      continue;
    }
    if (!isActive(grant.validity, now)) {
      if (grant.effect === "allow") {
        denials.push({
          role: displayRole,
          reason: "inactive-grant",
          detail: grant.validity,
        });
      } else {
        skip(tracer, grant, permission.key, "validity");
      }
      continue;
    }
    const merged: Grant = freezeDeep(
      compact({
        ...grant,
        where: combineWhere(grant.where, granteeMatch.where),
      }),
    );
    const condition = evaluateGrantCondition(
      merged,
      permission,
      current,
      next,
      subject,
      now,
      scopes,
      env.relations,
    );
    if (
      !condition.matched &&
      grant.effect === "deny" &&
      isUnevaluable(condition.reason) &&
      grantCoversField(grant.fields, options.field, grant.effect)
    ) {
      if (condition.reason === "closure-error") {
        emitSafe(
          env.listeners.error,
          condition.cause ?? new Error("closure-error"),
          env.listeners,
        );
      }
      tracer?.denies.push(matchedOf(merged, permission.key));
      return complete({
        outcome: "denied",
        denials: [
          {
            role: displayRole,
            reason: condition.reason ?? "relation-unavailable",
          },
        ],
        alternatives: [],
      });
    }
    if (!condition.matched) {
      if (condition.reason === "closure-error") {
        emitSafe(
          env.listeners.error,
          condition.cause ?? new Error("closure-error"),
          env.listeners,
        );
      }
      denials.push({
        role: displayRole,
        reason: condition.reason ?? "condition",
        detail: condition.cause,
      });
      continue;
    }
    if (!grantCoversField(grant.fields, options.field, grant.effect)) {
      skip(tracer, grant, permission.key, "field");
      continue;
    }
    if (grant.effect === "deny") {
      tracer?.denies.push(matchedOf(merged, permission.key));
      if (grant.name !== undefined && breakGlassOverrides.has(grant.name)) {
        if (breakGlassGrant !== undefined) {
          continue;
        }
        if (breakGlassDenial !== undefined) {
          return complete({
            outcome: "denied",
            denials: [breakGlassDenial],
            alternatives: env.skipAlternatives
              ? []
              : alternativesFor(policy, permission, subject, now, env),
          });
        }
      }
      return complete({
        outcome: "denied",
        denials: [
          grant.name === undefined
            ? { role: displayRole, reason: "deny" }
            : {
                role: displayRole,
                reason: "deny",
                detail: { name: grant.name },
              },
        ],
        alternatives: env.skipAlternatives
          ? []
          : alternativesFor(policy, permission, subject, now, env),
      });
    }
    tracer?.allows.push(matchedOf(merged, permission.key));
    allows.push(
      scopeMembership === undefined
        ? { grant: merged }
        : { grant: merged, membership: scopeMembership },
    );
  }

  if (breakGlassGrant !== undefined) {
    tracer?.allows.push(matchedOf(breakGlassGrant, permission.key, true));
    allows.push({
      grant: breakGlassGrant,
      obligations: breakGlassObligations,
      breakGlass: true,
    });
  } else if (breakGlassDenial !== undefined) {
    denials.unshift(breakGlassDenial);
  }

  if (allows.length === 0) {
    const reason: DenialReason =
      denials[0]?.reason ??
      (subject.principal === null
        ? "anonymous"
        : globalNames.unknown.length > 0 && globalNames.roles.length === 0
          ? "unknown-role"
          : "no-grant");
    return complete({
      outcome: "denied",
      denials: denials.length > 0 ? denials : [{ role: null, reason }],
      alternatives: env.skipAlternatives
        ? []
        : alternativesFor(policy, permission, subject, now, env),
    });
  }

  if (subject.stale === true && (policy.fresh ?? []).includes(permission.key)) {
    return complete({
      outcome: "denied",
      denials: [{ role: null, reason: "stale-credentials" }],
      alternatives: [],
    });
  }

  // A policy delegation is a ceiling for the actor: outside it, nothing is
  // delegated; inside it, a token delegation on the call must still cover.
  const ceiling = delegatedPermissions(
    policy.delegations,
    subject,
    matchingRoles,
    now,
  );
  if (ceiling !== undefined && !ceiling.has(permission.key)) {
    return complete({
      outcome: "denied",
      denials: [{ role: null, reason: "not-delegated" }],
      alternatives: env.skipAlternatives
        ? []
        : alternativesFor(policy, permission, subject, now, env),
    });
  }
  const delegationMiss = coveredByDelegation(
    permission,
    subject.delegation,
    resourceIdOf(current),
    subject.actor !== undefined && ceiling === undefined,
  );
  if (delegationMiss !== undefined) {
    return complete({
      outcome: "denied",
      denials: [{ role: null, reason: delegationMiss }],
      alternatives: env.skipAlternatives
        ? []
        : alternativesFor(policy, permission, subject, now, env),
    });
  }

  const approvalPolicies = env.approvalPolicies;
  if (approvalPolicies === "failed" && allows.length > 0) {
    return complete({
      outcome: "denied",
      denials: [
        {
          role: null,
          reason: "approval",
          detail: "approval-policy-unavailable",
        },
      ],
      alternatives: [],
    });
  }
  const approvalOf = (candidate: (typeof allows)[number]): Grant["approval"] =>
    approvalPolicies === undefined || approvalPolicies === "failed"
      ? candidate.grant.approval
      : tightenApproval(candidate.grant.approval, approvalPolicies, {
          permission: permission.key,
          tenant: decisionTenant(subject, candidate.membership),
          subject,
          current,
          next,
          now,
          scopes: scopeList(policy.scopes),
        });
  const quotaDenials: Denial[] = [];
  let matchedAllow: (typeof allows)[number] | undefined;
  let approval: Grant["approval"];
  let quotaState: Pick<GrantedDecision, "quota" | "obligations"> = {};
  for (const candidate of allows) {
    approval = approvalOf(candidate);
    const consume =
      !requiresApproval(approval) &&
      shouldConsumeQuota(options.source, env.simulated);
    const quota = applyQuota({
      store: env.limits,
      cache: env.limitCache,
      grant: candidate.grant,
      permissionKey: permission.key,
      subjectId: subject.principal?.id ?? "",
      tenant: subject.principal?.tenant,
      now,
      consume,
    });
    if (quota.ok) {
      matchedAllow = candidate;
      quotaState = compact({
        quota: quota.quota,
        obligations: quota.obligations,
      });
      break;
    }
    quotaDenials.push(
      quota.reason === "limit"
        ? { role: candidate.grant.role, reason: "limit", detail: quota.detail }
        : { role: candidate.grant.role, reason: quota.reason },
    );
  }
  if (matchedAllow === undefined) {
    return complete({
      outcome: "denied",
      denials: quotaDenials.length > 0 ? quotaDenials : denials,
      alternatives: env.skipAlternatives
        ? []
        : alternativesFor(policy, permission, subject, now, env),
    });
  }

  // SAFETY: current is a non-null object checked in the condition; the read value stays unknown.
  const resourceId =
    permission.kind === "collection"
      ? "*"
      : current !== null && typeof current === "object"
        ? String(
            (current as Record<string, unknown>)[resource?.id ?? "id"] ?? "*",
          )
        : "*";
  const version =
    approval !== undefined &&
    approval !== "human" &&
    approval.staleOn === "resource-change" &&
    resource?.version !== undefined
      ? versionOf(current, resource.version)
      : undefined;
  const token = env.simulated
    ? "pd1.simulated"
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
    ...matchedOf(matchedAllow.grant, permission.key, matchedAllow.breakGlass),
    approval,
  });
  const obligations = [
    ...(quotaState.obligations ?? []),
    ...(matchedAllow.obligations ?? []),
  ];
  return complete(
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
    matchedAllow.membership,
  );
}
