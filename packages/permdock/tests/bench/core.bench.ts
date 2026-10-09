import { test } from "vitest";

import { createClientStore } from "../../src/client/store.ts";
import { createPermDock, fromSnapshot } from "../../src/core/permdock.ts";
import { snapshotFor } from "../../src/core/snapshot-for.ts";
import { alice, bob, permissions, policy } from "../fixtures/saas.ts";

const rows = Array.from({ length: 1000 }, (_, index) => ({
  id: `p${index}`,
  orgId: index % 2 === 0 ? "acme" : "globex",
  ownerId: index % 3 === 0 ? "bob" : "alice",
  archived: index % 7 === 0,
}));
const own = { id: "p0", orgId: "acme", ownerId: "bob", archived: false };

const snapshot = snapshotFor(policy, bob, { tenant: "acme" });
const client = fromSnapshot(snapshot, { tenant: "acme" });
const store = createClientStore({ snapshot, tenant: "acme" });

test("can", async ({ bench }) => {
  const member = await createPermDock(policy, bob, { tenant: "acme" });
  const admin = await createPermDock(policy, alice, { tenant: "acme" });
  await bench.compare(
    bench("collection grant", () => {
      admin.can(permissions.project.create);
    }),
    bench("instance grant with a where condition", () => {
      member.can(permissions.project.update, own);
    }),
    bench("instance deny overriding allow", () => {
      member.can(permissions.project.delete, own);
    }),
    bench("from a snapshot", () => {
      client.can(permissions.project.update, own);
    }),
  );
});

test("filter over 1,000 rows", async ({ bench }) => {
  const member = await createPermDock(policy, bob, { tenant: "acme" });
  const admin = await createPermDock(policy, alice, { tenant: "acme" });
  await bench.compare(
    bench("member with a where condition", () => {
      member.filter(permissions.project.update, rows);
    }),
    bench("admin with a deny", () => {
      admin.filter(permissions.project.delete, rows);
    }),
    bench("member from a snapshot", () => {
      client.filter(permissions.project.update, rows);
    }),
  );
});

test("snapshot", async ({ bench }) => {
  await bench.compare(
    bench("snapshotFor", () => {
      snapshotFor(policy, alice, { tenant: "acme" });
    }),
    bench("fromSnapshot", () => {
      fromSnapshot(snapshot, { tenant: "acme" });
    }),
  );
});

test("client store", async ({ bench }) => {
  await bench.compare(
    bench("permissionState, cached answer", () => {
      store.permissionState(permissions.project.update, own);
    }),
    bench("permissionState, 20 reads of one row in a render pass", () => {
      for (let read = 0; read < 20; read += 1) {
        store.permissionState(permissions.project.update, own);
      }
    }),
  );
});
