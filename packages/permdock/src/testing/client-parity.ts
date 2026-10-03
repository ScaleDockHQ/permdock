import { expect, it } from "vitest";

import type { Permission, Policy, RoleSource } from "../index.ts";

import { createPermDock, fromSnapshot, parseSnapshot } from "../index.ts";

export type ClientParityCase = {
  readonly name: string;
  /** The value the policy's `subject` function receives. */
  readonly user: unknown;
  readonly tenant?: string | undefined;
  readonly permission: Permission;
  readonly row?: unknown;
  /**
   * `true` when the client may deny what the server grants, because the
   * outcome depends on a closure, a quota or an approval the snapshot omits.
   */
  readonly stricter?: boolean;
};

export type ClientParityOptions = {
  readonly customRoles?: RoleSource;
};

async function outcomes(
  policy: Policy,
  entry: ClientParityCase,
  options: ClientParityOptions,
): Promise<{ readonly server: boolean; readonly client: boolean }> {
  const server = await createPermDock(policy, entry.user, {
    ...(entry.tenant === undefined ? {} : { tenant: entry.tenant }),
    ...(options.customRoles === undefined
      ? {}
      : { customRoles: options.customRoles }),
  });
  const client = fromSnapshot(parseSnapshot(JSON.stringify(server.snapshot())));
  // SAFETY: the case's permission and row are erased to fit both can() overloads alike.
  return {
    server: server.can(entry.permission as never, entry.row as never),
    client: client.can(entry.permission as never, entry.row as never),
  };
}

/**
 * Asserts that `fromSnapshot(permdock.snapshot())` never grants what the
 * server denies, and matches it exactly unless a case is marked `stricter`.
 */
export function testClientParity(
  policy: Policy,
  cases: readonly ClientParityCase[],
  options: ClientParityOptions = {},
): void {
  for (const entry of cases) {
    it(`client parity: ${entry.name}`, async () => {
      const result = await outcomes(policy, entry, options);
      if (!result.server) {
        expect(result.client, "client granted what the server denied").toBe(
          false,
        );
        return;
      }
      if (entry.stricter !== true) {
        expect(result.client, "client denied what the server granted").toBe(
          true,
        );
      }
    });
  }
}
