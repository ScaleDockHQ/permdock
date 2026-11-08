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

  it("lists 300 tools faster than through the wire snapshot", () => {
    const tools = toolPermissions();
    const timeOf = (permdock: PermDock): number => {
      const mayUse = mayUseOf(permdock);
      const started = performance.now();
      const used = tools.filter((permission) => mayUse(permission));
      expect(used).toHaveLength(300);
      return performance.now() - started;
    };
    const base = instance();
    // A spread copy drops the expanded view, so its first mayUse reads `snapshot()`.
    const wire = timeOf({ ...base });
    const direct = timeOf(base);
    // The snapshot keeps only the active tenant's grants, so the wire path fell from about 550 ms
    // to about 50 ms and the direct path stayed near 15 ms: the gap is no longer a fixed ratio.
    expect(direct).toBeLessThan(wire);
  });
});
