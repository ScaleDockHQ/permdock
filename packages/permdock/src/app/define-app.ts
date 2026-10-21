import type { AppDefinition, AppOptions } from "../core/app.ts";
import type { Grant, Policy, PolicyVocabulary } from "../core/policy-types.ts";
import type { Principal } from "../core/subject.ts";

import { memoryApprovalStore } from "../approvals/store.ts";
import { APP } from "../core/app.ts";
import { limits, memoryLimitStore } from "../core/limits.ts";

function grantsOf(policy: Policy): readonly Grant[] {
  return [...policy.index.grantsByKey.values()].flat();
}

function assertProduction(policy: Policy, options: AppOptions): void {
  const grants = grantsOf(policy);
  if (
    options.store === undefined &&
    grants.some((grant) => grant.approval !== undefined)
  ) {
    throw new Error(
      "PermDock: profile 'prod' needs a store: a grant requires approval and approvals cannot complete without an ApprovalStore",
    );
  }
  if (
    options.limits === undefined &&
    grants.some((grant) => grant.limit !== undefined)
  ) {
    throw new Error(
      "PermDock: profile 'prod' needs limits: a grant has a limit and every call would deny with limit-unavailable; pass limits: limits(store)",
    );
  }
}

/**
 * The in-process services `dev` fills in: one memory approval store that every
 * adapter of the app shares, and memory limits when a grant has a `limit`. They
 * live here, not in the adapters, so an adapter ships no store and an app
 * without `defineApp` ships neither.
 */
function devDefaults(policy: Policy, options: AppOptions): AppDefinition {
  return {
    ...options,
    profile: "dev",
    ...(options.store === undefined ? { store: memoryApprovalStore() } : {}),
    ...(options.limits === undefined &&
    grantsOf(policy).some((grant) => grant.limit !== undefined)
      ? { limits: limits(memoryLimitStore()) }
      : {}),
  };
}

/**
 * Binds the app's sources, features and services to `policy`. The result is a
 * policy: pass it wherever a policy goes (`createPermDock`, every adapter, the
 * CLI) and each picks up the app definition, with its own options taking
 * precedence. The profile defaults to `prod`.
 */
export function defineApp<
  TUser,
  TPrincipal extends Principal,
  V extends PolicyVocabulary,
>(
  policy: Policy<TUser, TPrincipal, V>,
  options: AppOptions = {},
): Policy<TUser, TPrincipal, V> {
  const profile = options.profile ?? "prod";
  const definition: AppDefinition =
    profile === "dev" ? devDefaults(policy, options) : { ...options, profile };
  if (profile === "prod") {
    assertProduction(policy, definition);
  }
  // SAFETY: a policy is a plain object (or null-prototype); the copy keeps its prototype and every own property, symbol-keyed ones included.
  const prototype = Object.getPrototypeOf(policy) as object | null;
  // SAFETY: the copy has the policy's own property descriptors, so it is the same Policy shape.
  const app = Object.create(
    prototype,
    Object.getOwnPropertyDescriptors(policy),
  ) as Policy<TUser, TPrincipal, V>;
  Object.defineProperty(app, APP, { value: Object.freeze(definition) });
  return Object.freeze(app);
}
