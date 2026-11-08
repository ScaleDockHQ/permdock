import { describe, test } from "vitest";

import { clientBundle } from "../../src/core/client-bundle.ts";
import { fromSnapshot, getPermDockSync } from "../../src/core/permdock.ts";
import { listPermissions } from "../../src/core/permission-registry.ts";
import { expandSnapshot } from "../../src/core/snapshot-compact.ts";
import { snapshotFor } from "../../src/core/snapshot-for.ts";
import { commerceUser, policy } from "../fixtures/centrakit-shape.ts";

const user = commerceUser();
const options = {
  tenant: "org0",
  tenants: "all",
  omitAssignable: true,
} as const;
const instance = getPermDockSync(policy, user, { tenant: "org0" });
const wire = snapshotFor(policy, user, options);
const lean = snapshotFor(policy, user, { ...options, omitStatic: true });
const bundle = clientBundle(policy);
const client = fromSnapshot(wire, { tenant: "org0" });
const leanClient = fromSnapshot(lean, { tenant: "org0", bundle });
const leaf = listPermissions(policy.permissions)[0];
if (leaf === undefined) {
  throw new TypeError("no permissions");
}
const row = { id: "r1", orgId: "org0", ownerId: "u-commerce", status: "open" };

describe("snapshot", () => {
  test("server build", async ({ bench }) => {
    await bench.compare(
      bench("instance.snapshot()", () => {
        instance.snapshot(options);
      }),
      bench("snapshotFor()", () => {
        snapshotFor(policy, user, options);
      }),
      bench("snapshotFor() with omitStatic", () => {
        snapshotFor(policy, user, { ...options, omitStatic: true });
      }),
    );
  });

  test("client read", async ({ bench }) => {
    await bench.compare(
      bench("expandSnapshot()", () => {
        expandSnapshot(wire);
      }),
      bench("fromSnapshot()", () => {
        fromSnapshot(wire, { tenant: "org0" });
      }),
      bench("expandSnapshot() with the bundle", () => {
        expandSnapshot(lean, { bundle });
      }),
      bench("fromSnapshot() with the bundle", () => {
        fromSnapshot(lean, { tenant: "org0", bundle });
      }),
      bench("serialise", () => {
        JSON.stringify(wire);
      }),
      bench("serialise with omitStatic", () => {
        JSON.stringify(lean);
      }),
      bench("decide() from the snapshot", () => {
        client.decide(leaf, row);
      }),
      bench("decide() with the bundle", () => {
        leanClient.decide(leaf, row);
      }),
    );
  });
});
