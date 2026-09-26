import { compact } from '../core/compact.ts';
import { freezeDeep } from '../core/freeze.ts';
import { matchFilter } from './filter.ts';
import {
  DirectoryNotFoundError,
  DirectoryUniquenessError,
  type DirectoryGroup,
  type DirectoryStore,
  type DirectoryUser,
  type ScimFilter,
  type ScimPage,
  type ScimPageResult,
  type ScimPatchOp,
} from './types.ts';

const DEFAULT_COUNT = 100;

function now(): string {
  return new Date().toISOString();
}

function randomId(prefix: string): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  let hex = '';
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0');
  }
  return `${prefix}${hex}`;
}

function directoryKey(tenant: string, id: string): string {
  return `${tenant}\0${id}`;
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function pageOf<T>(items: readonly T[], page: ScimPage): ScimPageResult<T> {
  const count = page.count ?? DEFAULT_COUNT;
  let start = 0;
  if (page.cursor !== undefined && page.cursor !== '') {
    const decoded = Math.trunc(Number(page.cursor));
    start = Number.isFinite(decoded) ? decoded : 0;
  } else if (page.startIndex !== undefined && page.startIndex > 0) {
    start = page.startIndex - 1;
  }
  const slice = items.slice(start, start + count);
  const nextIndex = start + slice.length;
  return compact<ScimPageResult<T>>({
    Resources: slice,
    totalResults: items.length,
    startIndex: start + 1,
    itemsPerPage: slice.length,
    nextCursor: nextIndex < items.length ? String(nextIndex) : undefined,
  });
}

function emailsOf(value: unknown): DirectoryUser['emails'] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.flatMap((item) => {
    if (item === null || typeof item !== 'object') {
      return [];
    }
    const record = item as {
      value?: unknown;
      primary?: unknown;
      type?: unknown;
    };
    if (typeof record.value !== 'string') {
      return [];
    }
    return [
      compact<{
        readonly value: string;
        readonly primary?: boolean;
        readonly type?: string;
      }>({
        value: record.value,
        primary:
          typeof record.primary === 'boolean' ? record.primary : undefined,
        type: typeof record.type === 'string' ? record.type : undefined,
      }),
    ];
  });
}

function membersOf(value: unknown): DirectoryGroup['members'] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((item) => {
    if (item === null || typeof item !== 'object') {
      return [];
    }
    const record = item as { value?: unknown };
    return typeof record.value === 'string' ? [{ value: record.value }] : [];
  });
}

function rolesOf(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  return value.filter((item): item is string => typeof item === 'string');
}

function memberValues(value: unknown): readonly string[] {
  return membersOf(value).map((member) => member.value);
}

function applyUserOp(user: DirectoryUser, op: ScimPatchOp): DirectoryUser {
  const path = op.path ?? '';
  if (path === 'active' && typeof op.value === 'boolean') {
    return { ...user, active: op.value };
  }
  if (path === 'userName' && typeof op.value === 'string') {
    return { ...user, userName: op.value };
  }
  if (path === 'externalId') {
    return compact<DirectoryUser>({
      ...user,
      externalId: typeof op.value === 'string' ? op.value : undefined,
    });
  }
  if (path === 'emails') {
    return compact<DirectoryUser>({ ...user, emails: emailsOf(op.value) });
  }
  return user;
}

function applyGroupOp(group: DirectoryGroup, op: ScimPatchOp): DirectoryGroup {
  const path = op.path ?? '';
  if (path === 'displayName' && typeof op.value === 'string') {
    return { ...group, displayName: op.value };
  }
  if (path === 'externalId') {
    return compact<DirectoryGroup>({
      ...group,
      externalId: typeof op.value === 'string' ? op.value : undefined,
    });
  }
  if (path === 'roles') {
    return compact<DirectoryGroup>({ ...group, roles: rolesOf(op.value) });
  }
  if (path !== 'members') {
    return group;
  }
  const incoming = memberValues(op.value);
  const current = group.members.map((member) => member.value);
  if (op.op === 'replace') {
    return { ...group, members: incoming.map((value) => ({ value })) };
  }
  if (op.op === 'add') {
    const next = [...current];
    for (const value of incoming) {
      if (!next.includes(value)) {
        next.push(value);
      }
    }
    return { ...group, members: next.map((value) => ({ value })) };
  }
  return {
    ...group,
    members: current
      .filter((value) => !incoming.includes(value))
      .map((value) => ({ value })),
  };
}

function stampUser(user: DirectoryUser, created?: string): DirectoryUser {
  const at = now();
  return freezeDeep({
    ...user,
    meta: compact({
      created: created ?? user.meta.created ?? at,
      lastModified: at,
      resourceType: 'User' as const,
      location: user.meta.location,
    }),
  });
}

function stampGroup(group: DirectoryGroup, created?: string): DirectoryGroup {
  const at = now();
  return freezeDeep({
    ...group,
    meta: compact({
      created: created ?? group.meta.created ?? at,
      lastModified: at,
      resourceType: 'Group' as const,
      location: group.meta.location,
    }),
  });
}

export function memoryDirectoryStore(): DirectoryStore {
  const users = new Map<string, DirectoryUser>();
  const groups = new Map<string, DirectoryGroup>();

  function usersIn(tenant: string): DirectoryUser[] {
    const found: DirectoryUser[] = [];
    for (const [key, user] of users) {
      if (key.startsWith(`${tenant}\0`)) {
        found.push(user);
      }
    }
    return found;
  }

  function groupsIn(tenant: string): DirectoryGroup[] {
    const found: DirectoryGroup[] = [];
    for (const [key, group] of groups) {
      if (key.startsWith(`${tenant}\0`)) {
        found.push(group);
      }
    }
    return found;
  }

  function assertUserUnique(
    tenant: string,
    user: DirectoryUser,
    ignoreId?: string,
  ): void {
    for (const existing of usersIn(tenant)) {
      if (existing.id === ignoreId) {
        continue;
      }
      if (existing.userName === user.userName) {
        throw new DirectoryUniquenessError('userName');
      }
      if (
        user.externalId !== undefined &&
        existing.externalId === user.externalId
      ) {
        throw new DirectoryUniquenessError('externalId');
      }
    }
  }

  function assertGroupUnique(
    tenant: string,
    group: DirectoryGroup,
    ignoreId?: string,
  ): void {
    for (const existing of groupsIn(tenant)) {
      if (existing.id === ignoreId) {
        continue;
      }
      if (
        group.externalId !== undefined &&
        existing.externalId === group.externalId
      ) {
        throw new DirectoryUniquenessError('externalId');
      }
    }
  }

  return {
    getUser(tenant, id) {
      return Promise.resolve(users.get(directoryKey(tenant, id)) ?? null);
    },
    findUsers(tenant, filter: ScimFilter | undefined, page: ScimPage) {
      const matched = usersIn(tenant).filter((user) =>
        matchFilter(user, filter),
      );
      return Promise.resolve(pageOf(matched, page));
    },
    putUser(tenant, user) {
      try {
        const id = user.id === '' ? randomId('u_') : user.id;
        const existing = users.get(directoryKey(tenant, id));
        const next = stampUser({ ...user, id }, existing?.meta.created);
        assertUserUnique(tenant, next, id);
        users.set(directoryKey(tenant, id), next);
        return Promise.resolve(next);
      } catch (error) {
        return Promise.reject(asError(error));
      }
    },
    patchUser(tenant, id, ops) {
      try {
        const existing = users.get(directoryKey(tenant, id));
        if (existing === undefined) {
          throw new DirectoryNotFoundError();
        }
        let next = existing;
        for (const op of ops) {
          next = applyUserOp(next, op);
        }
        next = stampUser(next, existing.meta.created);
        assertUserUnique(tenant, next, id);
        users.set(directoryKey(tenant, id), next);
        return Promise.resolve(next);
      } catch (error) {
        return Promise.reject(asError(error));
      }
    },
    deleteUser(tenant, id) {
      if (!users.delete(directoryKey(tenant, id))) {
        return Promise.reject(new DirectoryNotFoundError());
      }
      for (const group of groupsIn(tenant)) {
        if (!group.members.some((member) => member.value === id)) {
          continue;
        }
        groups.set(
          directoryKey(tenant, group.id),
          stampGroup(
            {
              ...group,
              members: group.members.filter((member) => member.value !== id),
            },
            group.meta.created,
          ),
        );
      }
      return Promise.resolve();
    },
    getGroup(tenant, id) {
      return Promise.resolve(groups.get(directoryKey(tenant, id)) ?? null);
    },
    findGroups(tenant, filter: ScimFilter | undefined, page: ScimPage) {
      const matched = groupsIn(tenant).filter((group) =>
        matchFilter(group, filter),
      );
      return Promise.resolve(pageOf(matched, page));
    },
    putGroup(tenant, group) {
      try {
        const id = group.id === '' ? randomId('g_') : group.id;
        const existing = groups.get(directoryKey(tenant, id));
        const next = stampGroup(
          { ...group, id, members: group.members },
          existing?.meta.created,
        );
        assertGroupUnique(tenant, next, id);
        groups.set(directoryKey(tenant, id), next);
        return Promise.resolve(next);
      } catch (error) {
        return Promise.reject(asError(error));
      }
    },
    patchGroup(tenant, id, ops) {
      try {
        const existing = groups.get(directoryKey(tenant, id));
        if (existing === undefined) {
          throw new DirectoryNotFoundError();
        }
        let next = existing;
        for (const op of ops) {
          next = applyGroupOp(next, op);
        }
        next = stampGroup(next, existing.meta.created);
        assertGroupUnique(tenant, next, id);
        groups.set(directoryKey(tenant, id), next);
        return Promise.resolve(next);
      } catch (error) {
        return Promise.reject(asError(error));
      }
    },
    deleteGroup(tenant, id) {
      if (!groups.delete(directoryKey(tenant, id))) {
        return Promise.reject(new DirectoryNotFoundError());
      }
      return Promise.resolve();
    },
    groupsFor(tenant, userId) {
      return Promise.resolve(
        groupsIn(tenant).filter((group) =>
          group.members.some((member) => member.value === userId),
        ),
      );
    },
  };
}
