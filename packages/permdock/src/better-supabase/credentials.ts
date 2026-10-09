import type {
  CredentialProvider,
  CredentialRef,
} from "better-supabase/credentials";

import { AsyncResult, dbError } from "better-supabase";

import type { PermDock } from "../core/permdock.ts";
import type { Permission } from "../core/permissions.ts";

export type CredentialGuardOptions = {
  /** The request's PermDock instance. */
  readonly permdock: () => PermDock | Promise<PermDock>;
  /** The permission that resolves a token or connects an account; decided on the ref. */
  readonly use: Permission;
  /** The permission that revokes a stored credential; defaults to `use`. */
  readonly revoke?: Permission;
};

/**
 * `provider` with every `getToken`, `startAuthorization`,
 * `completeAuthorization` and `revoke` decided by PermDock first, on the
 * `CredentialRef` as the row. Anything but `granted` is a `forbidden`
 * error with hint `PERMDOCK_DENIED`, and a failed check is one too.
 * `capabilities` and `verifyInbound` (a third party's request, with no
 * user) pass through. Build it per request, with that request's PermDock.
 */
export function credentialGuard(
  provider: CredentialProvider,
  options: CredentialGuardOptions,
): CredentialProvider {
  const allowed = async (
    permission: Permission,
    ref: CredentialRef,
  ): Promise<boolean> => {
    try {
      return (await options.permdock()).can(permission, ref);
    } catch {
      return false;
    }
  };
  const guarded = <T>(
    permission: Permission,
    ref: CredentialRef,
    run: () => AsyncResult<T>,
  ): AsyncResult<T> =>
    AsyncResult.from(async () =>
      (await allowed(permission, ref))
        ? run()
        : AsyncResult.err<T>(
            dbError("forbidden", `PermDock denied ${permission.key}`, {
              hint: "PERMDOCK_DENIED",
            }),
          ),
    );
  const revoke = options.revoke ?? options.use;
  const start = provider.startAuthorization?.bind(provider);
  const complete = provider.completeAuthorization?.bind(provider);
  const inbound = provider.verifyInbound?.bind(provider);
  return Object.freeze({
    apiVersion: 1,
    name: provider.name,
    getToken: (ref, getOptions) =>
      guarded(options.use, ref, () => provider.getToken(ref, getOptions)),
    capabilities: (ref) => provider.capabilities(ref),
    ...(start === undefined
      ? {}
      : {
          startAuthorization: (ref, startOptions) =>
            guarded(options.use, ref, () => start(ref, startOptions)),
        }),
    ...(complete === undefined
      ? {}
      : {
          completeAuthorization: (ref, completeOptions) =>
            guarded(options.use, ref, () => complete(ref, completeOptions)),
        }),
    revoke: (ref, revokeOptions) =>
      guarded(revoke, ref, () => provider.revoke(ref, revokeOptions)),
    ...(inbound === undefined ? {} : { verifyInbound: inbound }),
  } satisfies CredentialProvider);
}
