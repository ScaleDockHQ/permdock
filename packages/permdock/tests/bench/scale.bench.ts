import { describe, test } from "vitest";

import { getPermDockSync } from "../../src/core/permdock.ts";
import { snapshotFor } from "../../src/core/snapshot-for.ts";
import {
  customRolesFor,
  permissions,
  policy,
  rowsFor,
  sourceFor,
  tenantId,
  toolPermissions,
  userFor,
} from "./scale-matrix.ts";

/** Corners of the full matrix in `scripts/runtime-perf.ts`. */
const CORNERS = [
  { memberships: 1, roles: 1, custom: 0 },
  { memberships: 12, roles: 5, custom: 50 },
  { memberships: 150, roles: 20, custom: 0 },
] as const;
const tenant = tenantId(0);
const rows = rowsFor(10_000, tenant);
const own = { id: "i0", orgId: tenant, ownerId: "u-scale" };

describe.each(CORNERS)(
  "scale $memberships memberships, $roles roles, $custom custom roles",
  ({ memberships, roles, custom }) => {
    const user = userFor(memberships, roles, custom);
    const source = sourceFor(memberships, custom);
    const build = () =>
      getPermDockSync(policy, user, { tenant, customRoles: source });
    const instance = build();

    test("check paths", async ({ bench }) => {
      await bench.compare(
        bench("instance build", () => {
          build();
        }),
        bench("can", () => {
          instance.can(permissions.item.update, own);
        }),
        bench("filter 10,000 rows", () => {
          instance.filter(permissions.item.update, rows);
        }),
        bench("where", () => {
          instance.where(permissions.item.update);
        }),
        bench("mayUse, one tool", () => {
          instance.mayUse(toolPermissions()[0]!);
        }),
        bench("snapshotFor", () => {
          snapshotFor(policy, user, {
            tenant,
            customRoles: customRolesFor(memberships, custom),
          });
        }),
      );
    });
  },
);
