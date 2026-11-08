import { describe, expect, it } from "vitest";

import type { Snapshot } from "../../src/core/snapshot-types.ts";

import { eagerEvaluator } from "../../src/client/evaluator-eager.ts";
import { createStore } from "../../src/client/store-core.ts";
import { clientBundle } from "../../src/core/client-bundle.ts";
import { getPermDockSync } from "../../src/core/permdock.ts";
import { alice, policy } from "../fixtures/saas.ts";

function lean(): Snapshot {
  const built = getPermDockSync(policy, alice, { tenant: "acme" }).snapshot({
    omitAssignable: true,
    omitStatic: true,
    tenants: "all",
  });
  if (built instanceof Promise) {
    throw new TypeError("expected JSON snapshot");
  }
  return built;
}

describe("a store with a bundle", () => {
  const create = policy.permissions.project.create;

  it("resolves static roles through the bundle", () => {
    const store = createStore(
      {
        snapshot: lean(),
        tenant: "acme",
        server: false,
        // SAFETY: the saas policy is the one the snapshot was written from; only the user generic is erased.
        bundle: clientBundle(policy as never),
      },
      eagerEvaluator,
    );
    expect(store.get().can(create)).toBe(true);
  });

  it("denies the same check without it", () => {
    const store = createStore(
      { snapshot: lean(), tenant: "acme", server: false },
      eagerEvaluator,
    );
    expect(store.get().can(create)).toBe(false);
  });
});
