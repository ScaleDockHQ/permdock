import type { AuthEvent, Snapshot } from './interfaces.ts';
import type { Policy, PolicyVocabulary } from './policy.ts';
import type { CustomRole, Membership, Principal, Subject } from './subject.ts';

import { compact } from './compact.ts';
import { freezeDeep } from './freeze.ts';
import { type SnapshotInclude, snapshotOf } from './instance.ts';
import { resolveSubject } from './resolve-subject.ts';
import { tenantsOf } from './tenancy.ts';
import { isThenable } from './thenable.ts';

export type SnapshotForOptions = {
  /** Active tenant; ignored unless the subject holds a membership in it. */
  readonly tenant?: string;
  /** Database mode: replaces the memberships carried by the subject. */
  readonly memberships?: readonly Membership[];
  /** The tenant's custom roles, typically from a shared, tagged cache. */
  readonly customRoles?: readonly CustomRole[];
  /** Plans of the active tenant; replaces `principal.plans`. */
  readonly plans?: readonly string[];
  readonly include?: SnapshotInclude;
  readonly tenants?: 'all';
  /** Epoch seconds for `issuedAt` and membership expiry. Defaults to the clock. */
  readonly now?: number;
};

function withPlans(
  subject: Subject,
  plans: readonly string[] | undefined,
): Subject {
  if (plans === undefined || subject.principal === null) {
    return subject;
  }
  return freezeDeep(
    compact<Subject>({
      ...subject,
      principal: compact<Principal>({
        ...subject.principal,
        plans: [...plans],
      }),
    }),
  );
}

/**
 * Builds the serializable access snapshot for a subject without a request,
 * a network call or a cache directive: call it inside the app's own
 * `'use cache: private'` function. Synchronous; the policy's `subject` and
 * `context` mappers must be synchronous too.
 */
export function snapshotFor<
  TUser,
  TPrincipal extends Principal = Principal,
  V extends PolicyVocabulary = PolicyVocabulary,
>(
  policy: Policy<TUser, TPrincipal, V>,
  user: TUser | Subject | null,
  options: SnapshotForOptions = {},
): Snapshot {
  const auth: AuthEvent[] = [];
  const memberships = options.memberships;
  const resolved = resolveSubject(
    policy as unknown as Policy,
    user,
    compact({
      tenant: options.tenant,
      memberships:
        memberships === undefined
          ? undefined
          : { membershipsFor: (): Membership[] => [...memberships] },
    }),
    auth,
  );
  if (isThenable(resolved)) {
    throw new TypeError(
      'PermDock: snapshotFor() needs synchronous subject and context mappers. Resolve async data first and pass it as a Subject, or use createPermDock(...).snapshot().',
    );
  }
  const subject = withPlans(resolved, options.plans);
  const tenants = new Set(tenantsOf(subject.principal));
  const customRoles = (options.customRoles ?? []).filter((item) =>
    tenants.has(item.tenant),
  );
  return snapshotOf(
    policy as unknown as Policy,
    subject,
    compact<Parameters<typeof snapshotOf>[2]>({
      customRoles,
      include: options.include,
      tenants: options.tenants,
      now: options.now,
    }),
  );
}
