import type { AuthEvent } from "./event-types.ts";
import type { SnapshotInclude } from "./instance-snapshot.ts";
import type { Policy, PolicyVocabulary } from "./policy-types.ts";
import type {
  ExpandedSnapshot,
  Snapshot,
  SnapshotTenants,
} from "./snapshot-types.ts";
import type { CustomRole, Membership, Principal, Subject } from "./subject.ts";
import type { Instant } from "./time.ts";

import { compactWithBundle } from "./client-bundle.ts";
import { compact } from "./compact.ts";
import { withoutCustomGrants } from "./custom-role-record.ts";
import { freezeDeep } from "./freeze.ts";
import { snapshotOf } from "./instance-snapshot.ts";
import { resolveSubject } from "./resolve-subject.ts";
import { scopeList } from "./scopes.ts";
import { compactSnapshot } from "./snapshot-compact.ts";
import { tenantsOf } from "./tenancy.ts";
import { isThenable } from "./thenable.ts";
import { nowSeconds } from "./time.ts";

export type SnapshotForOptions = {
  /** Active tenant; ignored unless the subject holds a membership in it. */
  readonly tenant?: string;
  /** Database mode: replaces the memberships carried by the subject. */
  readonly memberships?: readonly Membership[];
  /**
   * The tenant's custom roles, typically from a shared, tagged cache. The
   * snapshot names the roles a member holds and leaves their grants to the
   * `customRoleRecord` of the tenant, which `fromSnapshot` and the client store
   * take as `customRoles`; a role whose grants the record does not reproduce
   * stays inline.
   */
  readonly customRoles?: readonly CustomRole[];
  /**
   * Per tenant, the role names `CustomRoleSource.assignable` returns; narrows
   * `assignable`.
   */
  readonly assignable?: Readonly<Record<string, readonly string[]>>;
  /** Plans of the active tenant; replaces `principal.plans`. */
  readonly plans?: readonly string[];
  readonly include?: SnapshotInclude;
  readonly tenants?: SnapshotTenants;
  readonly omitAssignable?: boolean;
  /** See `SnapshotOptions.omitStatic`. */
  readonly omitStatic?: boolean;
  /** See `SnapshotOptions.maxGrantsPerTenant`. */
  readonly maxGrantsPerTenant?: number;
  /**
   * The wire version. `2` is the only one written, so the option pins it; any
   * other value is a `TypeError` rather than a silently ignored request.
   */
  readonly v?: 2;
  /** The instant for `issuedAt` and membership expiry. Defaults to the clock. */
  readonly now?: Instant;
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
 * Builds the serializable access snapshot for a subject without a request, a
 * network call or a cache directive: call it inside the app's own `'use cache:
 * private'` function. Synchronous; the policy's `subject` and `context` mappers
 * must be synchronous too.
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
  const version: number | undefined = options.v;
  if (version !== undefined && version !== 2) {
    throw new TypeError(
      `PermDock: snapshotFor() writes snapshot wire version 2 only, got v: ${String(version)}`,
    );
  }
  const full = expandedSnapshotFor(policy, user, options);
  // SAFETY: the generics only type the caller's side; the records read the erased policy.
  const erased = policy as unknown as Policy;
  const { snapshot: expanded, custom } = withoutCustomGrants(
    erased,
    full,
    options.customRoles ?? [],
  );
  return options.omitStatic === true
    ? compactWithBundle(erased, expanded, custom)
    : compactSnapshot(expanded, undefined, undefined, custom);
}

/** The flat form `snapshotFor` writes, as the server evaluated it. */
export function expandedSnapshotFor<
  TUser,
  TPrincipal extends Principal = Principal,
  V extends PolicyVocabulary = PolicyVocabulary,
>(
  policy: Policy<TUser, TPrincipal, V>,
  user: TUser | Subject | null,
  options: SnapshotForOptions,
): ExpandedSnapshot {
  const auth: AuthEvent[] = [];
  const memberships = options.memberships;
  // SAFETY: the generics only type the caller's side; resolveSubject reads the erased policy.
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
      "PermDock: snapshotFor() needs synchronous subject and context mappers. Resolve async data first and pass it as a Subject, or use (await getPermDock(...)).snapshot().",
    );
  }
  const subject = withPlans(resolved, options.plans);
  // SAFETY: the generic policy's scopes are the same runtime list as the erased Policy's.
  const tenants = new Set(
    tenantsOf(subject.principal, scopeList(policy.scopes as Policy["scopes"])),
  );
  const customRoles = (options.customRoles ?? []).filter(
    (item) =>
      item.scope === "global" ||
      (item.shared === true && tenants.size > 0) ||
      (item.tenant !== undefined && tenants.has(item.tenant)),
  );
  const names = options.assignable;
  const assignable =
    names === undefined
      ? undefined
      : new Map(
          [...tenants].map((tenant) => [
            tenant,
            Object.hasOwn(names, tenant) ? (names[tenant] ?? []) : [],
          ]),
        );
  // SAFETY: the generics only type the caller's side; snapshotOf reads the erased policy.
  return snapshotOf(
    policy as unknown as Policy,
    subject,
    compact<Parameters<typeof snapshotOf>[2]>({
      customRoles,
      assignable,
      include: options.include,
      tenants: options.tenants,
      omitAssignable: options.omitAssignable,
      maxGrantsPerTenant: options.maxGrantsPerTenant,
      now: options.now === undefined ? undefined : nowSeconds(options.now),
    }),
  );
}
