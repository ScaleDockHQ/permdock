import type { PermDockOptions } from "./permdock.ts";

type InstanceKey =
  | "memberships"
  | "relations"
  | "entitlements"
  | "customRoles"
  | "policies"
  | "approvalPolicies"
  | "sink"
  | "limits";

/**
 * The data sources an adapter passes through to every instance it creates.
 * Each adapter's options type extends this, so a source added to core
 * reaches every adapter without a per-adapter change.
 */
export type InstanceOptions = Pick<PermDockOptions, InstanceKey>;

const INSTANCE_KEYS: Readonly<Record<InstanceKey, true>> = {
  memberships: true,
  relations: true,
  entitlements: true,
  customRoles: true,
  policies: true,
  approvalPolicies: true,
  sink: true,
  limits: true,
};

/** The `InstanceOptions` set on `options`, without the adapter's own keys. */
export function instanceOptions(options: InstanceOptions): InstanceOptions {
  const picked: Partial<Record<InstanceKey, unknown>> = {};
  for (const key of Object.keys(INSTANCE_KEYS)) {
    // SAFETY: the keys of INSTANCE_KEYS are exactly InstanceKey.
    const name = key as InstanceKey;
    if (options[name] !== undefined) {
      picked[name] = options[name];
    }
  }
  // SAFETY: every key copied is an InstanceOptions key holding its own value.
  return picked as InstanceOptions;
}
