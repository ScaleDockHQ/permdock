import type { Denial } from "./decision.ts";
import type { Policy, RoleBinding } from "./policy-types.ts";
import type { CustomRole, Membership, Principal } from "./subject.ts";

import { compact, isReadonlyArray } from "./compact.ts";
import {
  customRoleId,
  customRoleOf,
  customRoleScope,
  tenantCustomRoles,
} from "./custom-roles.ts";
import { freezeDeep } from "./freeze.ts";
import { sameId } from "./ids.ts";
import { type InstanceHandle, internalsOf } from "./internals.ts";
import { declaredRoleNames } from "./policy.ts";
import { bindingOf, rankRoles, usesAssigns } from "./role-rank.ts";
import {
  type Scope,
  resolveScope,
  scopeChain,
  scopeList,
  scopeIdOf,
  tenantOf,
} from "./scopes.ts";
import { isMembershipExpired } from "./tenancy.ts";
import { type Role, findRole } from "./vocabulary.ts";

/**
 * Who a role change is about: their principal id and their membership in the
 * scope instance.
 */
export type RoleChangeTarget = {
  readonly id: string;
  /**
   * The kind of the target's membership in the instance (`staff`, `contact`,
   * ...).
   */
  readonly via?: string;
  /** The roles the target holds in the instance now. */
  readonly roles?: readonly string[];
  /**
   * `idp` when the identity provider owns the target's membership: the
   * application cannot change it.
   */
  readonly managedBy?: "idp";
};

type RoleChangeBase = {
  readonly kind: "assign" | "revoke" | "transfer";
  readonly role: string | Role;
  /** Ids of the instance's ancestor scopes; a holder there may assign here. */
  readonly within?: Readonly<Record<string, string>>;
  readonly target: RoleChangeTarget;
  /**
   * How many principals hold `role` in the instance now, from the application's
   * store. Without it a role with `min`, `max` or `transferOnly` is denied.
   */
  readonly holders?: number;
};

/**
 * A role held at a named scope instance (`scope` is a declared name or alias
 * and `id` the instance), or a global role: `scope: 'global'` with no `id`. A
 * global change has no tenant, so `within` and `holders` do not apply to it.
 */
export type RoleChange = RoleChangeBase &
  (
    | {
        /** The scope the role is held at (a declared name or alias). */
        readonly scope: string;
        /** The scope instance. */
        readonly id: string;
      }
    | { readonly scope: "global"; readonly id?: undefined }
  );

/**
 * `granted` names the role that authorised the change (`null` when a
 * `meta.manageRoles` holder or the declared-role ceiling did); `denied` lists
 * every rule the change breaks.
 */
export type RoleChangeDecision =
  | {
      readonly outcome: "granted";
      readonly change: RoleChange;
      readonly role: string | null;
    }
  | {
      readonly outcome: "denied";
      readonly change: RoleChange;
      readonly denials: readonly Denial[];
    };

function coversInstance(
  membership: Membership,
  scopes: readonly Scope[],
  scope: string,
  id: string,
  within: Readonly<Record<string, string>> | undefined,
): boolean {
  if (membership.scope === undefined || membership.id === undefined) {
    return false;
  }
  if (membership.scope === scope) {
    return sameId(membership.id, id);
  }
  const ancestors = scopeChain(scopes, scope).slice(1);
  if (!ancestors.includes(membership.scope)) {
    return false;
  }
  const wanted =
    within === undefined
      ? undefined
      : (Object.entries(within).find(
          ([key]) => resolveScope(scopes, key) === membership.scope,
        )?.[1] ?? undefined);
  return (
    wanted !== undefined && scopeIdOf(membership, membership.scope) === wanted
  );
}

/**
 * Roles the principal holds at the instance, at an ancestor named in `within`,
 * or globally.
 */
function rolesAtInstance(
  policy: Policy,
  principal: Principal,
  scopes: readonly Scope[],
  scope: string,
  id: string,
  within: Readonly<Record<string, string>> | undefined,
  now: number,
): readonly string[] {
  const declared = declaredRoleNames(policy);
  const names = new Set<string>(
    (principal.roles ?? []).filter((name) => declared.has(name)),
  );
  for (const membership of principal.memberships ?? []) {
    if (
      !isMembershipExpired(membership, now) &&
      coversInstance(membership, scopes, scope, id, within)
    ) {
      for (const name of membership.roles) {
        names.add(name);
      }
    }
  }
  return rankRoles(policy, [...names]);
}

/**
 * Whether the principal holds `role` on a live membership of exactly this
 * instance.
 */
function holdsAt(
  principal: Principal,
  role: string,
  scope: string,
  id: string,
  now: number,
): boolean {
  return (principal.memberships ?? []).some(
    (membership) =>
      membership.scope === scope &&
      sameId(membership.id, id) &&
      !isMembershipExpired(membership, now) &&
      membership.roles.includes(role),
  );
}

function includedRoles(role: CustomRole): readonly string[] {
  return isReadonlyArray(role.includes)
    ? role.includes.filter((name): name is string => typeof name === "string")
    : [];
}

/**
 * The membership kinds a custom role may be held through: those every included
 * declared role with `for` allows. `undefined` when none restricts.
 */
function customForKinds(
  policy: Policy,
  role: CustomRole,
): readonly string[] | undefined {
  let kinds: readonly string[] | undefined;
  for (const name of includedRoles(role)) {
    const listed = bindingOf(policy, name)?.for;
    if (listed !== undefined) {
      kinds =
        kinds === undefined
          ? listed
          : kinds.filter((kind) => listed.includes(kind));
    }
  }
  return kinds;
}

function conflictsWith(policy: Policy, role: string): ReadonlySet<string> {
  const out = new Set(bindingOf(policy, role)?.exclusiveWith ?? []);
  for (const binding of policy.roles) {
    if (binding.exclusiveWith?.includes(role) === true) {
      out.add(binding.name);
    }
  }
  return out;
}

/** What the change does to the instance's holder count. */
function countRules(
  rules: RoleRules,
  holders: number | undefined,
  delta: -1 | 0 | 1,
  deny: (reason: Denial["reason"], detail?: unknown) => void,
): void {
  const role = rules.key;
  if (delta === 0) {
    return;
  }
  const min = rules.min ?? 0;
  const counted =
    min > 0 || rules.max !== undefined || rules.transferOnly === true;
  if (!counted) {
    return;
  }
  const known =
    holders !== undefined && Number.isInteger(holders) && holders >= 0;
  if (!known) {
    const reason =
      delta < 0 && min > 0
        ? "last-holder"
        : delta > 0 && rules.max !== undefined
          ? "max-holders"
          : "transfer-only";
    deny(reason, { role, holders: null });
    return;
  }
  const after = holders + delta;
  if (delta < 0 && min > 0 && after < min) {
    deny("last-holder", { role, min, holders });
  }
  if (delta > 0 && rules.max !== undefined && after > rules.max) {
    deny("max-holders", { role, max: rules.max, holders });
  }
  // Creating the first holder and removing the last are not transfers; `min` guards the latter.
  if (rules.transferOnly === true && holders > 0 && after > 0) {
    deny("transfer-only", { role, holders });
  }
}

/**
 * The holder-count, membership-kind, exclusivity and `assigns` rules of one
 * role, as the catalog lists them (`CatalogRole`).
 */
export type RoleRules = {
  readonly key: string;
  readonly min?: number;
  readonly max?: number;
  readonly transferOnly?: boolean;
  readonly assigns?: readonly string[];
  readonly for?: readonly string[];
  readonly exclusiveWith?: readonly string[];
};

export type RoleChangeCheckInput = {
  readonly change: {
    readonly kind: "assign" | "revoke" | "transfer";
    readonly target: Pick<RoleChangeTarget, "via" | "roles">;
  };
  /**
   * How many principals hold the role in the instance now; without it a role
   * with `min`, `max` or `transferOnly` is denied.
   */
  readonly holders?: number;
  /**
   * Every declared role: adds the `exclusiveWith` other roles declare against
   * this one, and with `actorRoles` the `assigns` rule.
   */
  readonly roles?: readonly RoleRules[];
  /**
   * The roles the actor holds at the instance, highest rank first. With `roles`
   * naming any `assigns`, one of them must assign this role.
   */
  readonly actorRoles?: readonly string[];
};

/**
 * `by` names the actor role whose `assigns` allowed the change, `null` when the
 * rule did not apply.
 */
export type RoleChangeCheck =
  | { readonly ok: true; readonly by: string | null }
  | { readonly ok: false; readonly denials: readonly Denial[] };

/**
 * The rules of a role change that need no subject: `assigns`, `for`,
 * `exclusiveWith`, `min`, `max` and `transferOnly`, from holder counts and the
 * target's roles alone. `decideRoleChange` runs the same function after its
 * actor, tenant and ceiling checks; a service that holds only the catalog calls
 * it with the `CatalogRole` entries.
 */
export function checkRoleChange(
  role: RoleRules,
  input: RoleChangeCheckInput,
): RoleChangeCheck {
  const name = role.key;
  const denials: Denial[] = [];
  const deny = (reason: Denial["reason"], detail?: unknown): void => {
    denials.push(compact<Denial>({ role: name, reason, detail }));
  };
  const kind = input.change?.kind;
  const target = input.change?.target;
  if (
    (kind !== "assign" && kind !== "revoke" && kind !== "transfer") ||
    target === null ||
    typeof target !== "object"
  ) {
    deny("validation");
    return freezeDeep({ ok: false as const, denials });
  }
  const roles = input.roles ?? [];
  const targetRoles = isReadonlyArray(target.roles) ? target.roles : [];
  const already = targetRoles.includes(name);
  let by: string | null = null;

  if (
    kind !== "transfer" &&
    input.actorRoles !== undefined &&
    roles.some((rules) => rules.assigns !== undefined)
  ) {
    const held = input.actorRoles;
    by =
      held.find(
        (actorRole) =>
          roles
            .find((rules) => rules.key === actorRole)
            ?.assigns?.includes(name) === true,
      ) ?? null;
    if (by === null) {
      deny("not-assignable-by", { held });
    }
  }

  if (kind !== "revoke" && !already) {
    const kinds = role.for;
    if (
      kinds !== undefined &&
      (target.via === undefined || !kinds.includes(target.via))
    ) {
      deny("not-allowed-for-membership", {
        via: target.via ?? null,
        for: kinds,
      });
    }
    const conflicts = new Set(role.exclusiveWith ?? []);
    for (const rules of roles) {
      if (rules.exclusiveWith?.includes(name) === true) {
        conflicts.add(rules.key);
      }
    }
    const clash = targetRoles.filter((held) => conflicts.has(held));
    if (clash.length > 0) {
      deny("conflicting-role", { with: clash });
    }
  }

  const delta: -1 | 0 | 1 =
    kind === "assign"
      ? already
        ? 0
        : 1
      : kind === "revoke"
        ? targetRoles.length > 0 && !already
          ? 0
          : -1
        : already
          ? -1
          : 0;
  countRules(role, input.holders, delta, deny);
  return freezeDeep(
    denials.length === 0
      ? { ok: true as const, by }
      : { ok: false as const, denials },
  );
}

/** A declared binding's rules, by the name `checkRoleChange` reads. */
function rulesOf(binding: RoleBinding): RoleRules {
  return compact<RoleRules>({
    key: binding.name,
    min: binding.min,
    max: binding.max,
    transferOnly: binding.transferOnly,
    assigns: binding.assigns,
    for: binding.for,
    exclusiveWith: binding.exclusiveWith,
  });
}

export type RoleChangeOptions = {
  /**
   * `true` when the application loaded `change.within` from its own store (the
   * instance's stored parent), not from the request. Without it, a nested
   * instance's tenant comes only from a live membership the actor holds on that
   * instance or under it.
   */
  readonly trusted?: boolean;
};

/**
 * A live membership of the principal on the instance or on an instance under
 * it: the one in-band fact that ties a nested instance to a tenant.
 */
function heldAnchor(
  principal: Principal,
  scopes: readonly Scope[],
  scope: string,
  id: string,
  now: number,
): Membership | undefined {
  return (principal.memberships ?? []).find(
    (membership) =>
      !isMembershipExpired(membership, now) &&
      membership.scope !== undefined &&
      scopeChain(scopes, membership.scope).includes(scope) &&
      scopeIdOf(membership, scope) === id &&
      tenantOf(membership, scopes) !== undefined,
  );
}

export type AssignAuthority = {
  /**
   * Role names the ceiling (`assignableRoles`) lets the actor hand out in the
   * instance's tenant, or globally.
   */
  readonly assignable: ReadonlySet<string>;
  /** The actor holds a `meta.manageRoles` role or permission there. */
  readonly manage: boolean;
  /**
   * Custom roles that allow nothing after the ceiling: not assignable, but
   * revocable by an actor who assigns at their scope.
   */
  readonly inert?: ReadonlySet<string>;
};

/**
 * The one rule check behind `permdock.decideRoleChange`. The actor is always
 * the instance's own principal; nothing in `change` can stand in for it.
 */
/**
 * Whether the subject of `permdock` may assign, revoke or transfer a role in
 * one scope instance: `assigns`, the ceiling, `for`, `exclusiveWith`, `min`,
 * `max` and `transferOnly`. It never writes; the application does, and
 * generated RLS triggers re-check the holder counts at commit. A nested
 * instance's tenant comes from a live membership the subject holds on it, or
 * from `change.within` only with `{ trusted: true }`; otherwise
 * `no-membership`. An instance built from a snapshot denies with
 * `unsupported`.
 */
export function decideRoleChange(
  permdock: InstanceHandle,
  change: RoleChange,
  options: RoleChangeOptions = {},
): RoleChangeDecision {
  const internals = internalsOf(permdock);
  if (internals === undefined) {
    return freezeDeep({
      outcome: "denied",
      change,
      denials: [{ role: null, reason: "unsupported" }],
    });
  }
  const { policy, subject } = internals;
  return decideRoleChangeWith(
    policy,
    subject.principal,
    scopeList(policy.scopes),
    change,
    internals.env.customRoles,
    (tenant) => {
      const found = internals.assignable(tenant);
      return {
        assignable: new Set(found.roles.map((leaf) => leaf.key)),
        manage: found.manage,
        inert: new Set(found.inert),
      };
    },
    internals.now(),
    options,
  );
}

function decideRoleChangeWith(
  policy: Policy,
  principal: Principal | null,
  scopes: readonly Scope[],
  change: RoleChange,
  customRoles: readonly CustomRole[],
  authority: (tenant: string | undefined) => AssignAuthority,
  now: number,
  options: RoleChangeOptions = {},
): RoleChangeDecision {
  const name =
    typeof change?.role === "string" ? change.role : change?.role?.key;
  const denials: Denial[] = [];
  const deny = (reason: Denial["reason"], detail?: unknown): void => {
    denials.push(compact<Denial>({ role: name ?? null, reason, detail }));
  };
  const done = (role: string | null): RoleChangeDecision =>
    freezeDeep(
      denials.length === 0
        ? { outcome: "granted" as const, change, role }
        : { outcome: "denied" as const, change, denials },
    );
  if (principal === null) {
    deny("anonymous");
    return done(null);
  }
  const kind = change?.kind;
  const target = change?.target;
  const global = change?.scope === "global";
  if (
    typeof name !== "string" ||
    (kind !== "assign" && kind !== "revoke" && kind !== "transfer") ||
    (global
      ? change.id !== undefined
      : typeof change.id !== "string" || change.id === "") ||
    target === null ||
    typeof target !== "object" ||
    typeof target.id !== "string" ||
    target.id === ""
  ) {
    deny("validation");
    return done(null);
  }
  const id = change.id ?? "";
  const binding = bindingOf(policy, name);
  const declared = declaredRoleNames(policy).has(name);
  const named =
    declared || global
      ? []
      : tenantCustomRoles(policy, customRoles).filter(
          (role) => role.name === name,
        );
  if (!declared && named.length === 0) {
    deny("unknown-role");
    return done(null);
  }
  const scope = global ? "global" : resolveScope(scopes, change.scope);
  const customAt = named.map((role) => customRoleScope(role, scopes));
  const on = declared
    ? (binding?.on ?? findRole(policy.vocabulary?.roles, name)?.on)
    : customAt.includes(scope)
      ? scope
      : customAt[0];
  const heldAt =
    typeof on === "string"
      ? resolveScope(scopes, on)
      : global
        ? "global"
        : undefined;
  if (scope === undefined || heldAt === undefined || heldAt !== scope) {
    deny("scope", { expected: heldAt ?? null });
    return done(null);
  }
  let tenant: string | undefined;
  let within = change.within;
  let custom: CustomRole | undefined;
  if (!global) {
    const root = scopes[0]?.name;
    const supplied =
      change.within === undefined
        ? undefined
        : Object.entries(change.within).find(
            ([key]) => resolveScope(scopes, key) === root,
          )?.[1];
    if (scope === root) {
      tenant = id;
    } else {
      const anchor = heldAnchor(principal, scopes, scope, id, now);
      const held = anchor === undefined ? undefined : tenantOf(anchor, scopes);
      if (held !== undefined) {
        tenant = supplied === undefined || supplied === held ? held : undefined;
        within = anchor?.within;
      } else if (options.trusted === true) {
        tenant = supplied;
      }
    }
    if (tenant === undefined) {
      deny("no-membership", { scope, id });
      return done(null);
    }
    const found = tenant;
    custom = named.find(
      (role) =>
        customRoleOf(role, found) &&
        customRoleScope(role, scopes) === scope &&
        sameId(customRoleId(role) ?? id, id),
    );
  }
  if (!declared && custom === undefined) {
    deny("unknown-role");
    return done(null);
  }
  if (target.managedBy === "idp") {
    deny("externally-managed");
    return done(null);
  }
  const self = target.id === principal.id;
  let by: string | null = null;
  let actorRoles: readonly string[] | undefined;

  if (kind === "transfer") {
    if (self) {
      deny("self-demotion");
    }
    if (
      global
        ? (principal.roles ?? []).includes(name)
        : holdsAt(principal, name, scope, id, now)
    ) {
      by = name;
    } else {
      deny("not-assignable-by", { holds: false });
    }
  } else {
    if (self) {
      deny(kind === "revoke" ? "self-demotion" : "not-assignable-by", {
        self: true,
      });
    }
    const allowed = authority(tenant);
    const revocable =
      kind === "revoke" && custom !== undefined && allowed.inert?.has(name);
    if (!allowed.assignable.has(name) && revocable !== true) {
      deny("not-assignable-by");
    } else if (custom === undefined && usesAssigns(policy) && !allowed.manage) {
      actorRoles = global
        ? rankRoles(
            policy,
            (principal.roles ?? []).filter((role) =>
              declaredRoleNames(policy).has(role),
            ),
          )
        : rolesAtInstance(policy, principal, scopes, scope, id, within, now);
    }
  }

  const conflicts =
    custom === undefined
      ? conflictsWith(policy, name)
      : new Set(
          includedRoles(custom).flatMap((include) =>
            Array.from(conflictsWith(policy, include)),
          ),
        );
  const checked = checkRoleChange(
    compact<RoleRules>({
      ...(binding === undefined ? {} : rulesOf(binding)),
      key: name,
      for: custom === undefined ? binding?.for : customForKinds(policy, custom),
      exclusiveWith: [...conflicts],
      assigns: undefined,
    }),
    compact<RoleChangeCheckInput>({
      change: { kind, target },
      holders: change.holders,
      roles: actorRoles === undefined ? undefined : policy.roles.map(rulesOf),
      actorRoles,
    }),
  );
  if (checked.ok) {
    by = actorRoles === undefined ? by : checked.by;
  } else {
    denials.push(...checked.denials);
  }
  return done(by);
}
