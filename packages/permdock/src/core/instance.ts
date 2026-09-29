import type { Decision } from './decision.ts';
import type {
  AuthEvent,
  DecisionSink,
  LimitStore,
  RoleSource,
  Snapshot,
} from './interfaces.ts';
import type { DecideOptions, PermDock, WhereResult } from './permdock.ts';
import type { Permission } from './permissions.ts';
import type { Grant, Policy } from './policy.ts';
import type { CustomRole, Membership, Principal, Subject } from './subject.ts';
import type { Role } from './vocabulary.ts';

import {
  type ArazzoPlan,
  type ArazzoSimulateInput,
  isArazzoSimulateInput,
  simulateArazzo,
} from './arazzo.ts';
import { compact } from './compact.ts';
import {
  type CustomGrant,
  ceilingGrants,
  customGrantsFor,
  holdsCustomRole,
  roleAllowKeys,
} from './custom-roles.ts';
import {
  PermDockApprovalRequiredError,
  PermDockDeniedError,
  PermDockValidationError,
  approvalMessage,
  deniedMessage,
} from './errors.ts';
import { declaredRoleNames, evaluate, expandRoleNames } from './evaluate.ts';
import { type EvalEnv, emitSafe, emptyListeners, finish } from './events.ts';
import { pickVisible } from './fields.ts';
import { freezeDeep } from './freeze.ts';
import { combineWhere, flattenGrantee, matchGrantee } from './grantee.ts';
import { getResource, listPermissions } from './permissions.ts';
import { grantList } from './policy.ts';
import { buildSnapshot, signSnapshot, snapshotGrant } from './snapshot.ts';
import {
  isMembershipExpired,
  nowSeconds,
  relatesTo,
  resolveActiveTenant,
  tenantsOf,
} from './tenancy.ts';
import { findRole, listRoles, synthesiseRole } from './vocabulary.ts';
import { whereFromGrants } from './where-scope.ts';

function includePrefixes(
  include:
    | readonly (Permission | { readonly [key: string]: unknown })[]
    | undefined,
): readonly string[] | undefined {
  if (include === undefined) {
    return undefined;
  }
  return include.map((item) => {
    if ('key' in item && typeof item.key === 'string') {
      return item.key;
    }
    const leaves = listPermissions(item as never);
    const first = leaves[0];
    if (first === undefined) {
      return '';
    }
    const parts = first.key.split('.');
    parts.pop();
    return parts.join('.');
  });
}

function heldRoleNames(subject: Subject, tenant?: string): readonly string[] {
  if (subject.principal === null) {
    return [];
  }
  const names = new Set<string>(subject.principal.roles ?? []);
  for (const membership of subject.principal.memberships ?? []) {
    if (membership.tenant !== tenant) {
      continue;
    }
    for (const role of membership.roles) {
      names.add(role);
    }
  }
  return [...names];
}

/**
 * Every grant the subject may reach, once per membership that holds all of
 * its scoped roles, so a client can check that membership's tenant, team or
 * resource. A scoped role held only globally reaches nothing.
 */
export function collectSnapshotGrants(
  policy: Policy,
  subject: Subject,
  customRoles: readonly CustomRole[],
  now: number = nowSeconds(),
  customGrants: readonly CustomGrant[] = customGrantsFor(policy, customRoles),
): readonly { readonly grant: Grant; readonly membership?: Membership }[] {
  const declared = declaredRoleNames(policy);
  const global = expandRoleNames(
    subject.principal?.roles ?? [],
    declared,
    customRoles,
    subject.principal?.tenant,
  );
  const held = (subject.principal?.memberships ?? []).map((membership) => ({
    membership,
    roles: new Set(
      expandRoleNames(
        membership.roles,
        declared,
        customRoles,
        membership.tenant,
      ).roles,
    ),
  }));
  const out: { readonly grant: Grant; readonly membership?: Membership }[] = [];
  for (const grant of grantList(policy)) {
    const resource = getResource(policy.permissions, grant.permission.resource);
    const match = matchGrantee(grant.to, subject, now, resource);
    if (!match.matched) {
      continue;
    }
    const roleItems = flattenGrantee(grant.to).filter(
      (item) => item.kind === 'role',
    );
    if (roleItems.length > 0 && subject.principal === null) {
      continue;
    }
    const globalOk = roleItems.every(
      (item) => item.scope !== 'global' || global.roles.includes(item.role),
    );
    if (!globalOk) {
      continue;
    }
    const merged: Grant = freezeDeep(
      compact({
        ...grant,
        where: combineWhere(grant.where, match.where),
      }),
    );
    const scoped = roleItems.filter((item) => item.scope !== 'global');
    if (scoped.length === 0) {
      out.push({ grant: merged });
      continue;
    }
    for (const entry of held) {
      if (scoped.every((item) => entry.roles.has(item.role))) {
        out.push({ grant: merged, membership: entry.membership });
      }
    }
  }
  for (const { grant, role } of customGrants) {
    const holders = held.filter((entry) =>
      holdsCustomRole(entry.membership, role),
    );
    if (holders.length === 0) {
      continue;
    }
    const resource = getResource(policy.permissions, grant.permission.resource);
    const match = matchGrantee(grant.to, subject, now, resource);
    if (!match.matched) {
      continue;
    }
    const merged: Grant = freezeDeep(
      compact({
        ...grant,
        where: combineWhere(grant.where, match.where),
      }),
    );
    for (const entry of holders) {
      out.push({ grant: merged, membership: entry.membership });
    }
  }
  return out;
}

/** Declared roles a tenant admin may hand out or compose, before any intersection. */
function assignableCandidates(policy: Policy): readonly Role[] {
  const fromVocab = listRoles(policy.vocabulary?.roles).filter(
    (leaf) => leaf.assignable,
  );
  const seen = new Set(fromVocab.map((leaf) => leaf.key));
  const fromBindings = policy.roles
    .filter((binding) => binding.assignable && !seen.has(binding.name))
    .map((binding) =>
      synthesiseRole(
        binding.name,
        binding.on === 'tenant' || binding.on === 'team'
          ? { on: binding.on, assignable: true }
          : { assignable: true },
      ),
    );
  return [...fromVocab, ...fromBindings];
}

export type Assignable = {
  readonly roles: readonly Role[];
  readonly permissions: readonly Permission[];
};

/**
 * What the subject may hand out in `tenant`: declared assignable roles and the
 * tenant custom-role ceiling, narrowed by `allowed` (`RoleSource.assignable`),
 * then intersected with the permissions the subject holds there. Holding a
 * role or a granted permission with `meta.manageRoles` lifts the intersection.
 */
export function assignableIn(
  policy: Policy,
  subject: Subject,
  customRoles: readonly CustomRole[],
  customGrants: readonly CustomGrant[],
  tenant: string | undefined,
  allowed: readonly string[] | undefined,
  now: number = nowSeconds(),
): Assignable {
  const principal = subject.principal;
  if (principal === null) {
    return { roles: [], permissions: [] };
  }
  const scoped: Subject =
    tenant === undefined
      ? subject
      : freezeDeep(
          compact<Subject>({
            ...subject,
            principal: compact<Principal>({
              ...principal,
              tenant: resolveActiveTenant(principal, tenant),
            }),
          }),
        );
  const heldKeys = new Set(
    collectSnapshotGrants(policy, scoped, customRoles, now, customGrants)
      .filter(
        (item) =>
          item.grant.effect === 'allow' &&
          (item.membership === undefined ||
            (item.membership.tenant === tenant &&
              !isMembershipExpired(item.membership, now))),
      )
      .map((item) => item.grant.permission.key),
  );
  const heldNames = heldRoleNames(subject, tenant);
  const quiet: EvalEnv = {
    emit: false,
    simulated: true,
    skipAlternatives: true,
    customRoles,
    customGrants,
    listeners: emptyListeners(),
    sink: undefined,
    limits: undefined,
    limitCache: new Map(),
    team: undefined,
  };
  const manage =
    heldNames.some(
      (name) =>
        findRole(policy.vocabulary?.roles, name)?.meta.manageRoles === true,
    ) ||
    listPermissions(policy.permissions).some(
      (leaf) =>
        leaf.meta.manageRoles === true &&
        evaluate(
          policy,
          scoped,
          leaf,
          undefined,
          { source: 'simulate', trusted: true, now },
          quiet,
        ).outcome === 'granted',
    );
  const narrowed = allowed === undefined ? undefined : new Set<string>(allowed);
  const candidates = assignableCandidates(policy).filter(
    (leaf) => narrowed === undefined || narrowed.has(leaf.key),
  );
  const held = new Set(heldNames);
  const roles = manage
    ? candidates
    : candidates.filter((leaf) => {
        if (held.has(leaf.key)) {
          return true;
        }
        // A role with no allows yet may gain hosted grants later: only its holders assign it.
        const keys = [...roleAllowKeys(policy, leaf.key)];
        return keys.length > 0 && keys.every((key) => heldKeys.has(key));
      });
  const ceiling = new Set(
    ceilingGrants(policy, 'tenant', allowed).map(
      (grant) => grant.permission.key,
    ),
  );
  const permissions = listPermissions(policy.permissions).filter(
    (leaf) => ceiling.has(leaf.key) && (manage || heldKeys.has(leaf.key)),
  );
  return { roles, permissions };
}

export type SnapshotInclude = readonly (
  | Permission
  | { readonly [key: string]: unknown }
)[];

/** The one path from a resolved subject to a `Snapshot`; pure apart from the default clock. */
export function snapshotOf(
  policy: Policy,
  subject: Subject,
  options: {
    readonly customRoles: readonly CustomRole[];
    readonly customGrants?: readonly CustomGrant[];
    /** Role names `RoleSource.assignable` returned, per tenant. */
    readonly assignable?: ReadonlyMap<string, readonly string[]>;
    readonly include?: SnapshotInclude;
    readonly tenants?: 'all';
    readonly simulated?: boolean;
    readonly now?: number;
  },
): Snapshot {
  const now = options.now ?? nowSeconds();
  const customGrants =
    options.customGrants ?? customGrantsFor(policy, options.customRoles);
  return buildSnapshot(
    compact<Parameters<typeof buildSnapshot>[0]>({
      subject,
      roles: heldRoleNames(subject, subject.principal?.tenant),
      grants: collectSnapshotGrants(
        policy,
        subject,
        options.customRoles,
        now,
        customGrants,
      ),
      include: includePrefixes(options.include),
      tenants: options.tenants,
      simulated: options.simulated,
      now: Math.floor(now),
      vocabulary: policy.vocabulary,
      scopes: snapshotScopes(policy),
      assignable: (tenant: string) => {
        const found = assignableIn(
          policy,
          subject,
          options.customRoles,
          customGrants,
          tenant,
          options.assignable?.get(tenant),
          now,
        );
        return {
          tenant,
          roles: found.roles.map((leaf) => leaf.key),
          permissions: found.permissions,
        };
      },
    }),
  );
}

function snapshotScopes(policy: Policy): Snapshot['scopes'] {
  const { tenant, team } = policy.scopes;
  if (tenant === undefined && team === undefined) {
    return undefined;
  }
  const partitioned: Record<string, { tenant?: true; team?: true }> = {};
  for (const node of policy.resources.values()) {
    const entry = compact<{ tenant?: true; team?: true }>({
      tenant:
        tenant !== undefined && relatesTo(node, tenant.key, 'tenant')
          ? true
          : undefined,
      team:
        team !== undefined && relatesTo(node, team.key, 'team')
          ? true
          : undefined,
    });
    if (entry.tenant === true || entry.team === true) {
      partitioned[node.name] = entry;
    }
  }
  return compact<NonNullable<Snapshot['scopes']>>({
    tenant,
    team,
    partitioned:
      Object.keys(partitioned).length === 0 ? undefined : partitioned,
  });
}

export function buildInstance(
  policy: Policy,
  subject: Subject,
  envBase: {
    readonly customRoles: readonly CustomRole[];
    readonly sink: DecisionSink | undefined;
    readonly limits: LimitStore | undefined;
    readonly limitCache: Map<string, number>;
    readonly simulated: boolean;
    readonly roleSource: RoleSource | undefined;
    /** `RoleSource.assignable` per tenant, loaded with the custom roles. */
    readonly assignable?: ReadonlyMap<string, readonly string[]>;
    readonly queuedAuth: readonly AuthEvent[];
    /** Errors from building the instance (a dropped hosted grant), replayed to `on('error')`. */
    readonly queuedErrors?: readonly unknown[];
  },
  team?: string,
): PermDock {
  const listeners = emptyListeners();
  const queuedAuth = [...envBase.queuedAuth];
  const queuedErrors = [...(envBase.queuedErrors ?? [])];
  const customGrants = customGrantsFor(policy, envBase.customRoles);
  const assignableAt = (tenant: string | undefined): Assignable =>
    assignableIn(
      policy,
      subject,
      envBase.customRoles,
      customGrants,
      tenant,
      tenant === undefined ? undefined : envBase.assignable?.get(tenant),
    );
  const envFor = (emit: boolean): EvalEnv => ({
    emit,
    simulated: envBase.simulated,
    skipAlternatives: false,
    customRoles: envBase.customRoles,
    customGrants,
    listeners,
    sink: envBase.sink,
    limits: envBase.limits,
    limitCache: envBase.limitCache,
    team,
  });

  const decideImpl = (
    permission: Permission,
    data?: unknown,
    options?: DecideOptions,
  ): Decision =>
    evaluate(
      policy,
      subject,
      permission,
      data,
      options ?? {},
      envFor(options?.source !== 'simulate'),
    );

  const canImpl = (
    permission: Permission,
    data?: unknown,
    options?: DecideOptions,
  ): boolean => {
    try {
      return (
        decideImpl(permission, data, {
          ...options,
          source: options?.source ?? 'can',
        }).outcome === 'granted'
      );
    } catch {
      return false;
    }
  };

  const assertImpl = (
    permission: Permission,
    data?: unknown,
    options?: DecideOptions,
  ): Extract<Decision, { readonly outcome: 'granted' }> => {
    const decision = decideImpl(permission, data, {
      ...options,
      source: options?.source ?? 'assert',
    });
    if (decision.outcome === 'granted') {
      return decision;
    }
    const onDenied = options?.onDenied ?? policy.onDenied;
    if (onDenied !== undefined) {
      onDenied(decision);
    }
    const resource = getResource(policy.permissions, permission.resource);
    const resourceId =
      data !== null && typeof data === 'object'
        ? (data as Record<string, unknown>)[resource?.id ?? 'id']
        : undefined;
    const resourceRef = compact<{
      readonly type: string;
      readonly id?: string;
    }>({
      type: permission.resource,
      id: resourceId === undefined ? undefined : String(resourceId),
    });
    if (decision.outcome === 'approval-required') {
      throw new PermDockApprovalRequiredError({
        decision,
        permission: permission.key,
        scope: permission.scope,
        resource: resourceRef,
        message: approvalMessage(
          permission.key,
          decision.reason,
          decision.token,
        ),
      });
    }
    if (decision.denials.some((denial) => denial.reason === 'validation')) {
      const detail = decision.denials[0]?.detail;
      if (detail instanceof PermDockValidationError) {
        throw detail;
      }
    }
    throw new PermDockDeniedError({
      decision,
      permission: permission.key,
      scope: permission.scope,
      resource: resourceRef,
      subject,
      message: deniedMessage(
        permission.key,
        subject.principal?.id,
        decision.denials,
        decision.alternatives.map((leaf) => leaf.key),
      ),
    });
  };

  const instance: PermDock = {
    can: canImpl as PermDock['can'],
    decide: decideImpl as PermDock['decide'],
    assert: assertImpl as PermDock['assert'],
    permissions: policy.permissions,
    roles: policy.vocabulary?.roles ?? {},
    plans: policy.vocabulary?.plans ?? {},
    filter<T>(
      permission: Permission<string, T, 'instance'>,
      rows: readonly T[],
      options?: DecideOptions,
    ): T[] {
      const allowed: T[] = [];
      let granted = 0;
      let denied = 0;
      let approvalRequired = 0;
      const quiet = envFor(false);
      const trusted = options?.trusted ?? true;
      const decideOptions: DecideOptions = {
        ...options,
        source: 'filter',
        trusted,
      };
      for (const row of rows) {
        const decision = evaluate(
          policy,
          subject,
          permission,
          row,
          decideOptions,
          quiet,
        );
        if (decision.outcome === 'granted') {
          allowed.push(row);
          granted += 1;
        } else if (decision.outcome === 'approval-required') {
          approvalRequired += 1;
        } else {
          denied += 1;
        }
      }
      const summary: Decision =
        granted > 0
          ? freezeDeep({
              outcome: 'granted',
              subject: subject as Subject & { readonly principal: Principal },
              matched: {
                role: '*',
                permission: permission.key,
              },
              token: 'pd1.filter',
            })
          : freezeDeep({
              outcome: 'denied',
              denials: [{ role: null, reason: 'no-grant' }],
              alternatives: [],
            });
      finish(
        policy,
        subject,
        permission,
        rows[0],
        summary,
        decideOptions,
        { ...quiet, emit: true },
        trusted,
        undefined,
        { granted, denied, approvalRequired },
      );
      return allowed;
    },
    pick<T>(
      permission: Permission<string, T, 'instance'>,
      row: T,
      options?: DecideOptions,
    ): Partial<T> {
      if (row === null || typeof row !== 'object') {
        return {};
      }
      if (canImpl(permission, row, options) !== true) {
        return {};
      }
      return pickVisible(row, (field) => {
        const next = compact<DecideOptions>({ ...options, field });
        return canImpl(permission, row, next) === true;
      });
    },
    where(permission: Permission): WhereResult {
      const grants = collectSnapshotGrants(
        policy,
        subject,
        envBase.customRoles,
        nowSeconds(),
        customGrants,
      )
        .filter((item) => item.grant.permission.key === permission.key)
        .map((item) => snapshotGrant(item.grant, item.membership));
      return whereFromGrants(
        grants,
        compact({
          resource: permission.resource,
          resources: policy.resources,
          scopes: snapshotScopes(policy),
          tenant: subject.principal?.tenant,
          team,
          now: nowSeconds(),
          subject,
        }),
      );
    },
    actions(
      resource: Permission | { readonly [key: string]: unknown },
      data: unknown,
      options?: DecideOptions,
    ): Permission[] {
      const fromTree = listPermissions(resource as never);
      const leaves =
        fromTree.length > 0
          ? fromTree
          : 'resource' in resource && typeof resource.resource === 'string'
            ? listPermissions(policy.permissions).filter(
                (item) => item.resource === resource.resource,
              )
            : [];
      return leaves.filter((item) => canImpl(item, data, options) === true);
    },
    simulate: ((
      input:
        | readonly (readonly [Permission, unknown?])[]
        | {
            readonly roles?: readonly (string | Role)[];
            readonly memberships?: readonly Membership[];
            readonly tenant?: string;
          }
        | ArazzoSimulateInput,
    ): Decision[] | PermDock | ArazzoPlan => {
      if (Array.isArray(input)) {
        return input.map(([permission, data]) =>
          evaluate(
            policy,
            subject,
            permission,
            data,
            { source: 'simulate', trusted: true },
            envFor(false),
          ),
        );
      }
      if (isArazzoSimulateInput(input)) {
        return simulateArazzo(
          input,
          input.permissions ?? policy.permissions,
          (permission, data) =>
            evaluate(
              policy,
              subject,
              permission,
              data,
              { source: 'simulate', trusted: true },
              envFor(false),
            ),
        );
      }
      const preview = input as {
        readonly roles?: readonly (string | Role)[];
        readonly memberships?: readonly Membership[];
        readonly tenant?: string;
      };
      const previewRoles = preview.roles?.map((item) =>
        typeof item === 'string' ? item : item.key,
      );
      const previewPrincipal =
        subject.principal === null
          ? null
          : freezeDeep(
              compact<Principal>({
                ...subject.principal,
                roles: previewRoles ?? subject.principal.roles,
                memberships:
                  preview.memberships ?? subject.principal.memberships,
                tenant: preview.tenant ?? subject.principal.tenant,
              }),
            );
      const previewSubject: Subject = freezeDeep({
        ...subject,
        principal: previewPrincipal,
      });
      return buildInstance(
        policy,
        previewSubject,
        { ...envBase, simulated: true },
        team,
      );
    }) as PermDock['simulate'],
    snapshot(options) {
      const snapshot = snapshotOf(
        policy,
        subject,
        compact<Parameters<typeof snapshotOf>[2]>({
          customRoles: envBase.customRoles,
          customGrants,
          assignable: envBase.assignable,
          include: options?.include,
          tenants: options?.tenants,
          simulated: envBase.simulated,
        }),
      );
      if (options?.signer !== undefined) {
        return signSnapshot(snapshot, options.signer, options.audience);
      }
      return snapshot;
    },
    on(event, handler) {
      const set = listeners[event] as Set<(payload: unknown) => void>;
      set.add(handler);
      if (event === 'auth') {
        for (const queued of queuedAuth) {
          try {
            (handler as (payload: AuthEvent) => void)(queued);
          } catch (error) {
            emitSafe(listeners.error, error, listeners);
          }
        }
      }
      if (event === 'error') {
        for (const queued of queuedErrors) {
          try {
            handler(queued);
          } catch {
            // An error handler that throws has nowhere left to report.
          }
        }
      }
      return (): void => {
        set.delete(handler);
      };
    },
    tenant(id: string): PermDock {
      if (subject.principal === null) {
        return buildInstance(policy, subject, envBase, team);
      }
      const next = freezeDeep(
        compact<Subject>({
          ...subject,
          principal: compact<Principal>({
            ...subject.principal,
            tenant: resolveActiveTenant(subject.principal, id),
          }),
        }),
      );
      return buildInstance(policy, next, envBase, team);
    },
    team(id: string): PermDock {
      return buildInstance(policy, subject, envBase, id);
    },
    memberships(): readonly Membership[] {
      return subject.principal?.memberships ?? [];
    },
    tenants(): readonly string[] {
      return tenantsOf(subject.principal);
    },
    heldRoles(options?: { readonly tenant?: string }): readonly Role[] {
      const names = heldRoleNames(
        subject,
        options?.tenant ?? subject.principal?.tenant,
      );
      return names.map(
        (name) =>
          findRole(policy.vocabulary?.roles, name) ?? synthesiseRole(name),
      );
    },
    assignableRoles(options?: { readonly tenant?: string }): readonly Role[] {
      return assignableAt(options?.tenant ?? subject.principal?.tenant).roles;
    },
    assignablePermissions(options?: {
      readonly tenant?: string;
    }): readonly Permission[] {
      const tenant = options?.tenant ?? subject.principal?.tenant;
      return tenant === undefined ? [] : assignableAt(tenant).permissions;
    },
    subject,
  };
  return Object.freeze(instance);
}
