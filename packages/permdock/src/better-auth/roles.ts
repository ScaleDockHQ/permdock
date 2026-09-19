import type { DecisionSink, RoleSource } from '../core/interfaces.ts';
import type { PermissionTree } from '../core/permissions.ts';
import type { RoleBinding } from '../core/policy.ts';
import type { CustomRole } from '../core/subject.ts';
import type {
  BetterAuthAccessControl,
  BetterAuthLike,
  BetterAuthRoleChangeEvent,
  BetterAuthRoleSourceOptions,
  BetterAuthStatements,
  BetterAuthUnmatchedStatement,
} from './types.ts';

import { compact } from '../core/compact.ts';
import { freezeDeep } from '../core/freeze.ts';
import { listPermissions } from '../core/permissions.ts';
import { allow, role } from '../core/policy.ts';
import { membershipEvent } from '../core/sink.ts';
import {
  asStatements,
  parseOrganizationRoles,
  statementsCover,
} from './parse.ts';

export type SeededRoles = RoleBinding[] & {
  readonly unmatched: readonly BetterAuthUnmatchedStatement[];
};

function statementsOf(
  accessRole: BetterAuthAccessControl['roles'][string],
): BetterAuthStatements {
  return asStatements(accessRole.statements ?? accessRole.permissions);
}

export function rolesFromAccessControl(
  access: BetterAuthAccessControl,
  permissions: PermissionTree,
  options: { readonly on?: 'tenant' | 'global' } = {},
): SeededRoles {
  const leaves = listPermissions(permissions);
  const unmatched: BetterAuthUnmatchedStatement[] = [];
  const roles: RoleBinding[] = [];
  for (const [name, accessRole] of Object.entries(access.roles)) {
    const statements = statementsOf(accessRole);
    const grants = [];
    for (const [resource, actions] of Object.entries(statements)) {
      for (const action of actions) {
        const leaf = leaves.find(
          (item) => item.resource === resource && item.action === action,
        );
        if (leaf === undefined) {
          unmatched.push({ role: name, resource, action });
          continue;
        }
        grants.push(allow(leaf));
      }
    }
    roles.push(
      role(
        name,
        grants,
        options.on === 'tenant' ? { on: 'tenant' } : undefined,
      ),
    );
  }
  return Object.assign(roles, { unmatched });
}

export function betterAuthRoleSource(
  auth: BetterAuthLike,
  options: BetterAuthRoleSourceOptions = {},
): RoleSource {
  const assignableRoles = options.assignable ?? [];
  return {
    async rolesFor(tenant: string): Promise<CustomRole[]> {
      try {
        const raw = await auth.api?.listOrganizationRoles?.({
          query: { organizationId: tenant },
          headers: options.headers,
        });
        const dynamic = parseOrganizationRoles(raw);
        return dynamic.map((item) =>
          freezeDeep(
            compact<CustomRole>({
              tenant,
              name: item.name,
              includes: assignableRoles
                .filter((declared) =>
                  statementsCover(item.statements, declared.statements),
                )
                .map((declared) => declared.name),
            }),
          ),
        );
      } catch {
        return [];
      }
    },
    assignable(): string[] {
      return assignableRoles.map((item) => item.name);
    },
  };
}

export function onRoleChange(
  refresh: (event: BetterAuthRoleChangeEvent) => void | Promise<void>,
  options: { readonly sink?: DecisionSink } = {},
): (event: BetterAuthRoleChangeEvent) => Promise<void> {
  return async (event: BetterAuthRoleChangeEvent): Promise<void> => {
    await refresh(event);
    const sink = options.sink;
    if (sink === undefined || event.userId === undefined) {
      return;
    }
    const added =
      event.role !== undefined && event.role !== event.previousRole
        ? [event.role]
        : [];
    const removed =
      event.previousRole !== undefined && event.previousRole !== event.role
        ? [event.previousRole]
        : [];
    const operation =
      event.previousRole === undefined
        ? 'added'
        : event.role === undefined
          ? 'removed'
          : 'changed';
    try {
      await sink.write([
        membershipEvent(
          compact<Parameters<typeof membershipEvent>[0]>({
            source: 'better-auth',
            operation,
            principal: { id: event.userId },
            tenant: event.organizationId,
            team: event.teamId,
            roles: { added, removed },
            by: event.by,
          }),
        ),
      ]);
    } catch {
      // A throwing sink must never fail the role change.
    }
  };
}
