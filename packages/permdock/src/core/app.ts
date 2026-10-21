import type { ApprovalStore } from "../approvals/types.ts";
import type { InstanceOptions } from "./instance-options.ts";
import type { PermDockOptions } from "./permdock.ts";

/**
 * How strict `defineApp` is about the services the policy needs. `dev` fills in
 * in-process defaults (a memory approval store and a memory limit store) so a
 * new app runs before any infrastructure exists. `prod` throws at startup when
 * a grant needs a service the app does not configure, instead of denying at run
 * time.
 */
export type AppProfile = "dev" | "prod";

/**
 * Everything an app wires once and every adapter reads: the data sources, the
 * opt-in features and the services. An adapter's own options win over these,
 * key by key.
 */
export type AppOptions = InstanceOptions &
  Pick<PermDockOptions, "settings"> & {
    /** Where approval requests open and resume, for every adapter. */
    readonly store?: ApprovalStore;
    readonly profile?: AppProfile;
  };

/**
 * The app definition `defineApp` attached to a policy, as read back by core and
 * adapters.
 */
export type AppDefinition = AppOptions & { readonly profile: AppProfile };

// Symbol.for: one key across copies of this module (two bundler chunks, or a
// dist and a source import), so an adapter always sees the app definition.
export const APP: symbol = Symbol.for("permdock.app");

/**
 * The app definition bound to `policy` by `defineApp`, or `undefined` for a
 * plain policy.
 */
export function appOf(policy: object): AppDefinition | undefined {
  const value: unknown = Reflect.get(policy, APP);
  // SAFETY: defineApp is the only writer of APP and stores a frozen AppDefinition.
  return value === undefined ? undefined : (value as AppDefinition);
}

/**
 * `options` with the app's values under it, key by key, for an adapter factory
 * to call first: `options = withApp(policy, options)`.
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
