import type { AuthEvent } from "./event-types.ts";
import type { Policy, PolicyVocabulary } from "./policy-types.ts";
import type { SnapshotAssignable } from "./snapshot-types.ts";
import type { CustomRole, Principal, Subject } from "./subject.ts";
import type { Instant } from "./time.ts";

import { assignableIn } from "./assignable.ts";
import { compact } from "./compact.ts";
import { customGrantsFor } from "./custom-roles.ts";
import { freezeDeep } from "./freeze.ts";
import { resolveSubject } from "./resolve-subject.ts";
import { scopeList } from "./scopes.ts";
import { plainPermission } from "./snapshot.ts";
import { tenantsOf } from "./tenancy.ts";
import { isThenable } from "./thenable.ts";
import { nowSeconds } from "./time.ts";

export type AssignableForOptions = {
  /**
   * The tenant to read. A tenant the subject holds no membership in answers
   * nothing.
   */
  readonly tenant: string;
  /** The tenant's custom roles, typically from a shared, tagged cache. */
  readonly customRoles?: readonly CustomRole[];
  /**
   * The role names `CustomRoleSource.assignable` returns for `tenant`; narrows
   * the answer.
   */
  readonly assignable?: readonly string[];
  /** The instant for membership expiry. Defaults to the clock. */
  readonly now?: Instant;
};

/**
 * What the subject may hand out in one tenant: the `assignable` entry a
 * snapshot would carry for it, computed on demand. A page that needs the role
 * editor for the open tenant calls this instead of shipping every tenant's
 * entry with `snapshotFor(…, { tenants: 'all' })`. Synchronous, with no request
 * or cache directive, like `snapshotFor`.
 */
export function assignableFor<
  TUser,
  TPrincipal extends Principal = Principal,
  V extends PolicyVocabulary = PolicyVocabulary,
>(
  policy: Policy<TUser, TPrincipal, V>,
  user: TUser | Subject | null,
  options: AssignableForOptions,
): SnapshotAssignable {
  const auth: AuthEvent[] = [];
  // SAFETY: the generics only type the caller's side; resolveSubject reads the erased policy.
  const erased = policy as unknown as Policy;
  const resolved = resolveSubject(erased, user, {}, auth);
  if (isThenable(resolved)) {
    throw new TypeError(
      "PermDock: assignableFor() needs synchronous subject and context mappers. Resolve async data first and pass it as a Subject.",
    );
  }
  const none: SnapshotAssignable = {
    tenant: options.tenant,
    roles: [],
    permissions: [],
  };
  const now = nowSeconds(options.now);
  if (
    resolved.principal === null ||
    !tenantsOf(resolved.principal, scopeList(erased.scopes)).includes(
      options.tenant,
    )
  ) {
    return none;
  }
  const customRoles = options.customRoles ?? [];
  const found = assignableIn(
    erased,
    resolved,
    customRoles,
    customGrantsFor(erased, customRoles),
    options.tenant,
    options.assignable,
    now,
  );
  return freezeDeep(
    compact<SnapshotAssignable>({
      tenant: options.tenant,
      roles: found.roles.map((leaf) => leaf.key),
      permissions: found.permissions.map(plainPermission),
      levels: Object.keys(found.levels).length === 0 ? undefined : found.levels,
    }),
  );
}
