import type { AuthEvent } from './interfaces.ts';
import type { CreatePermDockOptions } from './permdock.ts';
import type { Policy } from './policy.ts';

import { compact } from './compact.ts';
import { sanitizeContext } from './fields.ts';
import { freezeDeep } from './freeze.ts';
import { applyRoleKinds } from './ownership.ts';
import { asMembershipSource } from './memberships.ts';
import { normalizeMemberships, scopeList } from './scopes.ts';
import {
  type Actor,
  type Delegation,
  type Membership,
  type Principal,
  type Subject,
  anonymousSubject,
  isPrincipal,
  isSubject,
} from './subject.ts';
import { resolveActiveTenant } from './tenancy.ts';
import { isThenable } from './thenable.ts';

function assemblePrincipal(
  policy: Policy,
  user: unknown,
  options: CreatePermDockOptions,
  auth: AuthEvent[],
): {
  readonly principal: Principal | null;
  readonly context:
    | Readonly<Record<string, unknown>>
    | Promise<Readonly<Record<string, unknown>>>;
  readonly actor: Actor | undefined;
  readonly delegation: Delegation | undefined;
  readonly session: string | undefined;
  readonly expiresAt: number | undefined;
  readonly memberships: readonly Membership[] | Promise<readonly Membership[]>;
  /** The memberships came from a live `MembershipSource` call, not from the token. */
  readonly live: boolean;
} {
  let principal: Principal | null;
  let context: Readonly<Record<string, unknown>> = {};
  let actor = options.actor;
  let delegation = options.delegation;
  let session = options.session;
  let expiresAt = options.expiresAt;
  try {
    if (user === null || user === undefined) {
      principal = policy.subject(user as never);
    } else if (isSubject(user)) {
      principal = user.principal;
      context = user.context;
      actor = user.actor ?? actor;
      delegation = user.delegation ?? delegation;
      session = user.session ?? session;
      expiresAt = user.expiresAt ?? expiresAt;
    } else if (isPrincipal(user)) {
      principal = user;
    } else {
      principal = policy.subject(user as never);
    }
  } catch {
    principal = null;
  }
  const contextResult = resolveContext(policy, user, context, auth);
  let memberships: readonly Membership[] | Promise<readonly Membership[]> =
    principal?.memberships ?? [];
  let live = false;
  const source =
    options.memberships === undefined
      ? undefined
      : asMembershipSource(options.memberships);
  const fromClaims =
    source?.claimsFirst === true &&
    principal?.memberships !== undefined &&
    principal.membershipsTruncated !== true;
  if (principal !== null && source !== undefined && !fromClaims) {
    live = true;
    try {
      memberships = source.membershipsFor(
        compact({ id: principal.id, kind: principal.kind }),
        compact({ tenant: options.tenant }),
      );
    } catch {
      auth.push({ reason: 'source-threw', source: 'memberships' });
      memberships = [];
    }
  }
  return {
    principal,
    context: contextResult,
    actor,
    delegation,
    session,
    expiresAt,
    memberships,
    live,
  };
}

function finishSubject(
  policy: Policy,
  assembled: ReturnType<typeof assemblePrincipal>,
  context: Readonly<Record<string, unknown>>,
  input: readonly Membership[],
  options: CreatePermDockOptions,
  extra: { readonly stale: boolean; readonly plans: readonly string[] },
): Subject {
  if (assembled.principal === null) {
    return freezeDeep(
      compact<Subject>({
        ...anonymousSubject(context),
        actor: assembled.actor,
        delegation: assembled.delegation,
        session: assembled.session,
        expiresAt: assembled.expiresAt,
      }),
    );
  }
  const scopes = scopeList(policy.scopes);
  const { roles, memberships } = applyRoleKinds(
    policy,
    assembled.principal.roles,
    normalizeMemberships(input, scopes),
  );
  const plans = [
    ...new Set([...(assembled.principal.plans ?? []), ...extra.plans]),
  ];
  const withMemberships: Principal = freezeDeep(
    compact<Principal>({
      ...assembled.principal,
      roles,
      memberships,
      plans: plans.length === 0 ? assembled.principal.plans : plans,
      tenant: activeTenantOf(policy, assembled, memberships, options),
    }),
  );
  return freezeDeep(
    compact<Subject>({
      principal: withMemberships,
      actor: assembled.actor,
      delegation: assembled.delegation,
      context: freezeDeep({ ...context }),
      session: assembled.session,
      expiresAt: assembled.expiresAt,
      stale: extra.stale ? (true as const) : undefined,
    }),
  );
}

function activeTenantOf(
  policy: Policy,
  assembled: ReturnType<typeof assemblePrincipal>,
  memberships: readonly Membership[],
  options: CreatePermDockOptions,
): string | undefined {
  if (assembled.principal === null) {
    return undefined;
  }
  return resolveActiveTenant(
    { ...assembled.principal, memberships },
    options.tenant ?? assembled.principal.tenant,
    scopeList(policy.scopes),
  );
}

function settle<T>(
  value: T | Promise<T>,
  fallback: T,
  onError: () => void,
): T | Promise<T> {
  if (isThenable(value)) {
    return Promise.resolve(value).catch(() => {
      onError();
      return fallback;
    });
  }
  return value;
}

/**
 * Whether the token's memberships are behind the source for `fresh`
 * permissions. Live memberships are never stale; token memberships are stale
 * unless a source reports a version the token's `authzVersion` has reached.
 */
function staleness(
  policy: Policy,
  assembled: ReturnType<typeof assemblePrincipal>,
  options: CreatePermDockOptions,
  auth: AuthEvent[],
): boolean | Promise<boolean> {
  const principal = assembled.principal;
  if (
    (policy.fresh ?? []).length === 0 ||
    principal === null ||
    assembled.live
  ) {
    return false;
  }
  const source =
    options.memberships === undefined
      ? undefined
      : asMembershipSource(options.memberships);
  const claimed = principal.authzVersion;
  if (source?.version === undefined || typeof claimed !== 'number') {
    return true;
  }
  const compare = (current: number | undefined): boolean =>
    current === undefined || claimed < current;
  try {
    const current = source.version({ id: principal.id });
    return isThenable(current)
      ? settle(Promise.resolve(current).then(compare), true, () => {
          auth.push({ reason: 'source-threw', source: 'memberships' });
        })
      : compare(current);
  } catch {
    auth.push({ reason: 'source-threw', source: 'memberships' });
    return true;
  }
}

function cleanNames(list: unknown): readonly string[] {
  return Array.isArray(list)
    ? list.filter(
        (item): item is string => typeof item === 'string' && item !== '',
      )
    : [];
}

function entitlementsOf(
  assembled: ReturnType<typeof assemblePrincipal>,
  tenant: string | undefined,
  options: CreatePermDockOptions,
  auth: AuthEvent[],
): readonly string[] | Promise<readonly string[]> {
  const source = options.entitlements;
  if (source === undefined || assembled.principal === null) {
    return [];
  }
  try {
    const found = source.entitlementsFor(
      { id: assembled.principal.id },
      compact({ tenant }),
    );
    return isThenable(found)
      ? settle(Promise.resolve(found).then(cleanNames), [], () => {
          auth.push({ reason: 'source-threw', source: 'entitlements' });
        })
      : cleanNames(found);
  } catch {
    auth.push({ reason: 'source-threw', source: 'entitlements' });
    return [];
  }
}

function resolveContext(
  policy: Policy,
  user: unknown,
  fallback: Readonly<Record<string, unknown>>,
  auth: AuthEvent[],
):
  | Readonly<Record<string, unknown>>
  | Promise<Readonly<Record<string, unknown>>> {
  if (policy.context === undefined) {
    return sanitizeContext(fallback);
  }
  try {
    const loaded = policy.context(user as never);
    if (isThenable(loaded)) {
      return loaded.then(
        (value) => sanitizeContext(value),
        () => {
          auth.push({ reason: 'source-threw', source: 'context' });
          return {};
        },
      );
    }
    return sanitizeContext(loaded);
  } catch {
    auth.push({ reason: 'source-threw', source: 'context' });
    return {};
  }
}

export function resolveSubject(
  policy: Policy,
  user: unknown,
  options: CreatePermDockOptions,
  auth: AuthEvent[],
): Subject | Promise<Subject> {
  const assembled = assemblePrincipal(policy, user, options, auth);
  const memberships = settle(assembled.memberships, [], () => {
    auth.push({ reason: 'source-threw', source: 'memberships' });
  });
  const stale = staleness(policy, assembled, options, auth);
  const withPlans = (
    resolved: readonly Membership[],
  ): readonly string[] | Promise<readonly string[]> =>
    entitlementsOf(
      assembled,
      activeTenantOf(
        policy,
        assembled,
        applyRoleKinds(
          policy,
          assembled.principal?.roles,
          normalizeMemberships(resolved, scopeList(policy.scopes)),
        ).memberships,
        options,
      ),
      options,
      auth,
    );
  if (
    isThenable(assembled.context) ||
    isThenable(memberships) ||
    isThenable(stale)
  ) {
    return Promise.all([
      Promise.resolve(assembled.context),
      Promise.resolve(memberships),
      Promise.resolve(stale),
    ]).then(async ([context, resolved, isStale]) =>
      finishSubject(policy, assembled, context, resolved, options, {
        stale: isStale,
        plans: await withPlans(resolved),
      }),
    );
  }
  const plans = withPlans(memberships);
  if (isThenable(plans)) {
    return Promise.resolve(plans).then((resolved) =>
      finishSubject(
        policy,
        assembled,
        assembled.context as Readonly<Record<string, unknown>>,
        memberships,
        options,
        { stale, plans: resolved },
      ),
    );
  }
  return finishSubject(
    policy,
    assembled,
    assembled.context,
    memberships,
    options,
    { stale, plans },
  );
}
