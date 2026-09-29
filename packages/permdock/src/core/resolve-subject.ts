import type { AuthEvent } from './interfaces.ts';
import type { CreatePermDockOptions } from './permdock.ts';
import type { Policy } from './policy.ts';

import { compact } from './compact.ts';
import { sanitizeContext } from './fields.ts';
import { freezeDeep } from './freeze.ts';
import { applyRoleKinds } from './ownership.ts';
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
  if (principal !== null && options.memberships !== undefined) {
    try {
      memberships = options.memberships.membershipsFor(
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
  };
}

function finishSubject(
  policy: Policy,
  assembled: ReturnType<typeof assemblePrincipal>,
  context: Readonly<Record<string, unknown>>,
  input: readonly Membership[],
  options: CreatePermDockOptions,
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
  const withMemberships: Principal = freezeDeep(
    compact<Principal>({
      ...assembled.principal,
      roles,
      memberships,
      tenant: resolveActiveTenant(
        { ...assembled.principal, memberships },
        options.tenant ?? assembled.principal.tenant,
        scopes,
      ),
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
    }),
  );
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
  if (isThenable(assembled.context) || isThenable(assembled.memberships)) {
    return Promise.all([
      Promise.resolve(assembled.context),
      Promise.resolve(assembled.memberships).catch(() => {
        auth.push({ reason: 'source-threw', source: 'memberships' });
        return [] as Membership[];
      }),
    ]).then(([context, memberships]) =>
      finishSubject(policy, assembled, context, memberships, options),
    );
  }
  return finishSubject(
    policy,
    assembled,
    assembled.context,
    assembled.memberships,
    options,
  );
}
