import type { ApprovalStore } from "./types.ts";

import { appOf, withApp } from "../core/app.ts";
import { memoryApprovalStore } from "./store.ts";

/**
 * An adapter's options with the app definition `defineApp` bound to
 * `policy` under them. Under `profile: "dev"` an adapter without a `store`
 * gets a memory store of its own, so approvals complete before a database
 * exists; under `prod` there is no default.
 */
export function adapterOptions<T extends { readonly store?: ApprovalStore }>(
  policy: object,
  given: T,
): T {
  const options = withApp(policy, given);
  if (options.store === undefined && appOf(policy)?.profile === "dev") {
    return { ...options, store: memoryApprovalStore() };
  }
  return options;
}
