import type {
  DirectoryEvent,
  MembershipEvent,
  SinkEvent,
} from '../core/interfaces.ts';
import type { ScimCredential } from './auth.ts';
import type { DirectoryGroup } from './types.ts';
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
