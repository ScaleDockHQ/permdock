import { expect, it } from "vitest";

import type { Permission, Policy, CustomRoleSource } from "../index.ts";

import {
  clientBundle,
  fromSnapshot,
  getPermDock,
  parseSnapshot,
} from "../index.ts";

export type ClientParityCase = {
  readonly name: string;
  /** The value the policy's `subject` function receives. */
  readonly user: unknown;
  readonly tenant?: string | undefined;
  readonly permission: Permission;
  readonly row?: unknown;
  /**
   * `true` when the client may deny what the server grants, because the outcome
   * depends on a closure, a quota or an approval the snapshot omits.
   */
  readonly stricter?: boolean;
};

export type ClientParityOptions = { readonly customRoles?: CustomRoleSource };

async function outcomes(
  policy: Policy,
  entry: ClientParityCase,
  options: ClientParityOptions,
): Promise<{ readonly server: boolean; readonly clients: readonly boolean[] }> {
  const server = await getPermDock(policy, entry.user, {
    ...(entry.tenant === undefined ? {} : { tenant: entry.tenant }),
    ...(options.customRoles === undefined
      ? {}
      : { customRoles: options.customRoles }),
  });
  const full = fromSnapshot(parseSnapshot(JSON.stringify(server.snapshot())));
  const lean = fromSnapshot(
    parseSnapshot(JSON.stringify(server.snapshot({ omitStatic: true }))),
    { bundle: clientBundle(policy) },
  );
  // SAFETY: the case's permission and row are erased to fit both can() overloads alike.
  const check = (permdock: { can: (...args: never[]) => boolean }): boolean =>
    permdock.can(entry.permission as never, entry.row as never);
  return { server: check(server), clients: [check(full), check(lean)] };
}

/**
 * Asserts that `fromSnapshot(permdock.snapshot())`, and the lean snapshot read
 * with `clientBundle(policy)`, never grant what the server denies, and match it
 * exactly unless a case is marked `stricter`.
 */
export function testClientParity(
  policy: Policy,
  cases: readonly ClientParityCase[],
  options: ClientParityOptions = {},
): void {
  for (const entry of cases) {
    it(`client parity: ${entry.name}`, async () => {
      const result = await outcomes(policy, entry, options);
      for (const client of result.clients) {
        if (!result.server) {
          expect(client, "client granted what the server denied").toBe(false);
        } else if (entry.stricter !== true) {
          expect(client, "client denied what the server granted").toBe(true);
        }
      }
    });
  }
}
