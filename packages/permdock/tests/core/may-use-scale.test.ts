import { describe, expect, it } from "vitest";

import type { PermDock } from "../../src/core/permdock.ts";

import { mayUseOf } from "../../src/core/may-use.ts";
import { getPermDockSync } from "../../src/core/permdock.ts";
import {
  permissions,
  policy,
  tenantId,
  toolPermissions,
  userFor,
} from "../bench/scale-matrix.ts";

const tenant = tenantId(0);

describe("mayUse on a subject with 150 memberships of 20 roles", () => {
  const instance = (): PermDock =>
    getPermDockSync(policy, userFor(150, 20, 0), { tenant });

  it("answers every tool as the instance snapshot does", () => {
    const base = instance();
    // A spread copy drops the instance's own expanded view, so it reads `snapshot()`.
    const viaSnapshot = mayUseOf({ ...base });
    const direct = mayUseOf(base);
    const asked = [permissions.item.read, ...toolPermissions()];
    expect(asked.map((permission) => direct(permission))).toStrictEqual(
      asked.map((permission) => viaSnapshot(permission)),
    );
    expect(direct(permissions.item.read)).toBe(true);
  });
});
