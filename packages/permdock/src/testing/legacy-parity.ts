import { expect, it } from "vitest";

import type { LegacyCheck, Permission, Policy } from "../index.ts";

import { getPermDock } from "../index.ts";

export type LegacyParityCase = {
  readonly name: string;
  /** The value the policy's `subject` function receives. */
  readonly user: unknown;
  readonly permission: Permission;
  readonly row?: unknown;
  /**
   * The answer PermDock should give where it intentionally differs from the
   * legacy check; absent means the two must agree.
   */
  readonly expect?: boolean;
};

/**
 * Asserts that the policy answers each case as the application's legacy check
 * does, or as the case's `expect` says where the difference is intended. Run it
 * before enforcing a permission with `shadowMode`.
 */
export function testLegacyParity(
  policy: Policy,
  legacy: LegacyCheck,
  cases: readonly LegacyParityCase[],
): void {
  for (const entry of cases) {
    it(`legacy parity: ${entry.name}`, async () => {
      const permdock = await getPermDock(policy, entry.user);
      // SAFETY: the case's permission and row are erased to fit the can() overloads alike.
      const ours = permdock.can(entry.permission as never, entry.row as never);
      const theirs = legacy({
        permission: entry.permission,
        data: entry.row,
        subject: permdock.subject,
      });
      expect({ permission: entry.permission.key, granted: ours }).toEqual({
        permission: entry.permission.key,
        granted: entry.expect ?? theirs,
      });
    });
  }
}
