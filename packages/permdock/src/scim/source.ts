import type { MembershipSource } from '../core/interfaces.ts';
import type { Membership } from '../core/subject.ts';
import type {
  DirectoryMembershipSourceOptions,
  DirectoryStore,
  DirectoryUser,
} from './types.ts';

import { compact } from '../core/compact.ts';
import { parseScimFilter } from './filter.ts';

function allowedRoles(
  roles: readonly string[] | undefined,
  assignable: readonly string[] | undefined,
  onUnknownRole: ((name: string) => void) | undefined,
): readonly string[] {
  if (roles === undefined) {
    return [];
  }
  if (assignable === undefined) {
    return roles;
  }
  const allowed = new Set(assignable);
  const kept: string[] = [];
  for (const name of roles) {
    if (allowed.has(name)) {
      kept.push(name);
      continue;
    }
    onUnknownRole?.(name);
  }
  return kept;
}

async function lookupUser(
  store: DirectoryStore,
  tenant: string,
  attribute: 'externalId' | 'userName',
  principalId: string,
): Promise<DirectoryUser | null> {
  const filter = parseScimFilter(`${attribute} eq "${principalId}"`);
  const found = await store.findUsers(tenant, filter, {
    startIndex: 1,
    count: 1,
  });
  return found.Resources[0] ?? null;
}

async function findUser(
  store: DirectoryStore,
  tenant: string,
  principalId: string,
  match: DirectoryMembershipSourceOptions['match'],
): Promise<DirectoryUser | null> {
  const mode = match ?? 'either';
  if (mode === 'externalId' || mode === 'either') {
    const user = await lookupUser(store, tenant, 'externalId', principalId);
    if (user !== null) {
      return user;
    }
  }
  if (mode === 'userName' || mode === 'either') {
    return lookupUser(store, tenant, 'userName', principalId);
  }
  return null;
}

export function directoryMembershipSource(
  store: DirectoryStore,
  options: DirectoryMembershipSourceOptions = {},
): MembershipSource {
  return {
    async membershipsFor(principal, query) {
      const tenant = query.tenant;
      if (tenant === undefined || tenant === '') {
        return [];
      }
      let user: DirectoryUser | null;
      try {
        user = await findUser(store, tenant, principal.id, options.match);
      } catch {
        return [];
      }
      if (user === null || !user.active) {
        return [];
      }
      let groups: readonly Awaited<
        ReturnType<DirectoryStore['groupsFor']>
      >[number][];
      try {
        groups = [...(await store.groupsFor(tenant, user.id))];
      } catch {
        return [];
      }
      const memberships: Membership[] = [];
      for (const group of groups) {
        const mapped = group.roles ?? options.groupRoles?.[group.id];
        memberships.push(
          compact<Membership>({
            tenant,
            team: group.id,
            roles: allowedRoles(
              mapped,
              options.assignable,
              options.onUnknownRole,
            ),
            via: `group:${group.id}`,
          }),
        );
      }
      return memberships;
    },
  };
}
