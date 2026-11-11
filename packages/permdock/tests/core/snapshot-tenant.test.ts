import { describe, expect, it } from "vitest";

import { clientBundle } from "../../src/core/client-bundle.ts";
import { fromSnapshot } from "../../src/core/permdock.ts";
import { listPermissions } from "../../src/core/permission-registry.ts";
import { snapshotFor } from "../../src/core/snapshot-for.ts";
import { listedTenantSnapshot } from "../../src/core/snapshot-tenant.ts";
import { parseSnapshot } from "../../src/core/snapshot.ts";
import { policy } from "../fixtures/centrakit-shape.ts";

const user = {
  id: "u-commerce",
  tenant: "org0",
  memberships: [
    { scope: "tenant", id: "org1", roles: ["viewer"] },
    { scope: "tenant", id: "org0", roles: ["admin"] },
    { scope: "tenant", id: "org2", roles: ["member"] },
  ],
};

describe(listedTenantSnapshot, () => {
  it("keeps the listed tenant's memberships and renumbers static references to them", () => {
    const wide = snapshotFor(policy, user, {
      tenant: "org0",
      omitAssignable: true,
      omitStatic: true,
    });
    expect(wide.static?.held).toStrictEqual([["admin", 1]]);
    const narrow = listedTenantSnapshot(wide);
    expect(narrow.subject.principal?.memberships).toStrictEqual([
      { scope: "tenant", id: "org0", roles: ["admin"] },
    ]);
    expect(narrow.static).toStrictEqual({
      ...wide.static,
      held: [["admin", 0]],
    });
    expect(parseSnapshot(JSON.parse(JSON.stringify(narrow)))).toStrictEqual(
      narrow,
    );
    const leaf = listPermissions(policy.permissions)[0];
    if (leaf === undefined) {
      throw new TypeError("no permissions");
    }
    const row = { id: "r1", orgId: "org0", ownerId: "u-other", status: "open" };
    const bundle = clientBundle(policy);
    expect(
      fromSnapshot(narrow, { tenant: "org0", bundle }).can(leaf, row),
    ).toBe(fromSnapshot(wide, { tenant: "org0", bundle }).can(leaf, row));
  });

  it("returns a snapshot that lists every tenant as it is", () => {
    const all = snapshotFor(policy, user, { tenant: "org0", tenants: "all" });
    expect(listedTenantSnapshot(all)).toBe(all);
  });
});
