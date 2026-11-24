import type { PermDock } from "./permdock.ts";
import type { Permission, PermissionTree } from "./permission-types.ts";
import type { Policy, PolicyVocabulary } from "./policy-types.ts";
import type { Principal } from "./subject.ts";

import { getPermDock } from "./permdock.ts";
import { listPermissions } from "./permission-registry.ts";

/** What `warm` measured: `ms` covers the instance and the first check. */
export type WarmReport = { readonly ok: boolean; readonly ms: number };

/** An object with a `warm()` for `instrumentation.ts`. */
export type Warmable = { readonly warm: () => Promise<WarmReport> };

/**
 * Builds one anonymous instance with `build` and runs one check on it, so the
 * first request pays neither. Never rejects: a failure answers `ok: false`.
 */
export async function warmUp(
  policy: { readonly permissions: PermissionTree },
  build: () => Promise<PermDock> | PermDock,
): Promise<WarmReport> {
  const start = performance.now();
  try {
    const instance = await build();
    const [first]: readonly (Permission | undefined)[] = listPermissions(
      policy.permissions,
    );
    if (first !== undefined) {
      // SAFETY: can accepts an instance or a collection permission and answers false for a row it needs and lacks.
      (instance.can as (permission: Permission) => boolean)(first);
    }
    return { ok: true, ms: performance.now() - start };
  } catch {
    return { ok: false, ms: performance.now() - start };
  }
}

/**
 * `warm(policy)`: the anonymous instance of `getPermDock`, for
 * `instrumentation.ts`.
 */
export function warm<
  TUser,
  TPrincipal extends Principal = Principal,
  V extends PolicyVocabulary = PolicyVocabulary,
>(policy: Policy<TUser, TPrincipal, V>): Promise<WarmReport> {
  return warmUp(policy, () => getPermDock(policy, null));
}
