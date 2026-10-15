import type { ApprovalStore } from "../approvals/types.ts";
import type { InstanceOptions } from "./instance-options.ts";
import type { PermDockOptions } from "./permdock.ts";
import type { Grant, Policy, PolicyVocabulary } from "./policy-types.ts";
import type { Principal } from "./subject.ts";

/**
 * How strict `defineApp` is about the services the policy needs. `dev`
 * fills in in-process defaults (a memory approval store in each adapter)
 * so a new app runs before any infrastructure exists; grant limits stay
 * opt-in through `limits(store)`. `prod` throws at startup when a grant needs a
 * service the app does not configure, instead of denying at run time.
 */
export type AppProfile = "dev" | "prod";

/**
 * Everything an app wires once and every adapter reads: the data sources,
 * the opt-in features and the services. An adapter's own options win over
 * these, key by key.
 */
export type AppOptions = InstanceOptions &
  Pick<PermDockOptions, "settings"> & {
    /** Where approval requests open and resume, for every adapter. */
    readonly store?: ApprovalStore;
    readonly profile?: AppProfile;
  };

/** The app definition `defineApp` attached to a policy, as read back by core and adapters. */
export type AppDefinition = AppOptions & { readonly profile: AppProfile };

// Symbol.for: one key across copies of this module (two bundler chunks, or a
// dist and a source import), so an adapter always sees the app definition.
const APP = Symbol.for("permdock.app");

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
 * Binds the app's sources, features and services to `policy`. The result
 * is a policy: pass it wherever a policy goes (`createPermDock`, every
 * adapter, the CLI) and each picks up the app definition, with its own
 * options taking precedence. The profile defaults to `prod`.
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
  const definition: AppDefinition = { ...options, profile };
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

/** The app definition bound to `policy` by `defineApp`, or `undefined` for a plain policy. */
export function appOf(policy: object): AppDefinition | undefined {
  const value: unknown = Reflect.get(policy, APP);
  // SAFETY: defineApp is the only writer of APP and stores a frozen AppDefinition.
  return value === undefined ? undefined : (value as AppDefinition);
}

/**
 * `options` with the app's values under it, key by key, for an adapter
 * factory to call first: `options = withApp(policy, options)`.
 */
export function withApp<T extends object>(policy: object, options: T): T {
  const app = appOf(policy);
  if (app === undefined) {
    return options;
  }
  const { profile: _profile, ...values } = app;
  const merged: Record<string, unknown> = { ...values };
  for (const [key, value] of Object.entries(options)) {
    if (value !== undefined) {
      merged[key] = value;
    }
  }
  // SAFETY: merged holds every key of options with its own value, plus AppOptions keys the adapter type leaves optional.
  return merged as T;
}
