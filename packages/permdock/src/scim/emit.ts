import type { DirectoryEvent, SinkEvent } from '../core/interfaces.ts';
import type { ScimCredential } from './auth.ts';
import type { ScimHandlerOptions } from './types.ts';

import { compact } from '../core/compact.ts';
import { memorySink } from '../core/sink.ts';

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

export async function emitDirectory(
  options: ScimHandlerOptions,
  event: DirectoryEvent,
  userIds: readonly string[],
): Promise<void> {
  const sink = options.sink ?? memorySink();
  try {
    await sink.write([event] as readonly SinkEvent[]);
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
