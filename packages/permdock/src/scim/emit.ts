import type {
  DirectoryEvent,
  MembershipEvent,
  SinkEvent,
} from '../core/interfaces.ts';
import type { ScimCredential } from './auth.ts';
import type { DirectoryGroup, DirectoryUser } from './types.ts';
import type { ScimHandlerOptions } from './types.ts';

import { compact } from '../core/compact.ts';
import { membershipEvent, memorySink } from '../core/sink.ts';

export function reportUnknownRoles(
  roles: readonly string[] | undefined,
  options: ScimHandlerOptions,
): void {
  if (roles === undefined || options.assignable === undefined) {
    return;
  }
  const allowed = new Set(options.assignable);
  for (const name of roles) {
    if (!allowed.has(name)) {
      options.onUnknownRole?.(name);
    }
  }
}

export function membershipEventsForGroup(input: {
  readonly tenant: string;
  readonly groupId: string;
  readonly roles: readonly string[];
  readonly previous: DirectoryGroup | null;
  readonly next: DirectoryGroup | null;
}): readonly MembershipEvent[] {
  const previousIds = new Set(
    input.previous?.members.map((member) => member.value) ?? [],
  );
  const nextIds = new Set(
    input.next?.members.map((member) => member.value) ?? [],
  );
  const roles = input.roles;
  const events: MembershipEvent[] = [];
  for (const id of nextIds) {
    if (previousIds.has(id)) {
      continue;
    }
    events.push(
      membershipEvent({
        source: 'scim',
        operation: 'added',
        principal: { id },
        tenant: input.tenant,
        via: `group:${input.groupId}`,
        roles: { added: roles, removed: [] },
      }),
    );
  }
  for (const id of previousIds) {
    if (nextIds.has(id)) {
      continue;
    }
    events.push(
      membershipEvent({
        source: 'scim',
        operation: 'removed',
        principal: { id },
        tenant: input.tenant,
        via: `group:${input.groupId}`,
        roles: { added: [], removed: roles },
      }),
    );
  }
  return events;
}

export async function emitDirectory(
  options: ScimHandlerOptions,
  event: DirectoryEvent,
  userIds: readonly string[],
  extra: readonly SinkEvent[] = [],
  /** Records read before a delete, when the store can no longer return them. */
  known: readonly DirectoryUser[] = [],
): Promise<void> {
  const sink = options.sink ?? memorySink();
  try {
    await sink.write([event, ...extra] as readonly SinkEvent[]);
  } catch {
    // A throwing sink must never fail the IdP write.
  }
  try {
    await options.onChange?.({ tenant: event.tenant, userIds });
  } catch {
    // Snapshot invalidation is best-effort.
  }
  await publishChanged(options, event.tenant, userIds, known);
}

/** Every identifier a principal may carry for these users, deduplicated. */
async function principalIds(
  options: ScimHandlerOptions,
  tenant: string,
  userIds: readonly string[],
  known: readonly DirectoryUser[],
): Promise<readonly string[]> {
  const ids = new Set<string>();
  const users = await Promise.all(
    userIds.map(async (id) => {
      const hit = known.find((user) => user.id === id);
      if (hit !== undefined) {
        return hit;
      }
      try {
        return await options.store.getUser(tenant, id);
      } catch {
        return null;
      }
    }),
  );
  for (const [index, user] of users.entries()) {
    ids.add(userIds[index] ?? '');
    if (user !== null) {
      ids.add(user.userName);
      if (user.externalId !== undefined) {
        ids.add(user.externalId);
      }
    }
  }
  ids.delete('');
  return [...ids];
}

async function publishChanged(
  options: ScimHandlerOptions,
  tenant: string,
  userIds: readonly string[],
  known: readonly DirectoryUser[],
): Promise<void> {
  const feed = options.revocations;
  if (feed === undefined || userIds.length === 0) {
    return;
  }
  try {
    for (const principal of await principalIds(
      options,
      tenant,
      userIds,
      known,
    )) {
      // oxlint-disable-next-line no-await-in-loop -- a feed may bridge to pub/sub
      await feed.revoke({ principal, tenant, kind: 'changed' });
    }
  } catch {
    // Connections fall back to their expiry when a feed is down.
  }
}

export function directoryEvent(input: {
  readonly operation: DirectoryEvent['operation'];
  readonly tenant: string;
  readonly type: 'User' | 'Group';
  readonly id: string;
  readonly credential: ScimCredential;
  readonly active?: boolean;
}): DirectoryEvent {
  return compact<DirectoryEvent>({
    type: 'directory',
    at: new Date().toISOString(),
    source: 'scim',
    operation: input.operation,
    tenant: input.tenant,
    resource: { type: input.type, id: input.id },
    credential: input.credential,
    active: input.active,
  });
}
