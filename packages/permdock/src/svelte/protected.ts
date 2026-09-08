import type { Snippet } from 'svelte';

import type { Decision } from '../core/decision.ts';
import type { Permission } from '../core/permissions.ts';
import type { ClientStore } from '../react/store.ts';
import type { ClientStatus, PermissionState } from './types.ts';

export type ProtectedProps = {
  readonly permission: Permission;
  readonly data?: unknown;
  readonly tenant?: string;
  readonly children?: Snippet<[Decision]>;
  readonly pending?: Snippet;
  readonly fallback?: Snippet<[Decision]>;
};

type DecideDock = {
  readonly decide: (permission: Permission, data?: unknown) => Decision;
};

export type ProtectedView = {
  readonly allowed: boolean;
  readonly status: ClientStatus;
  readonly decision: Decision;
  readonly slot: 'pending' | 'fallback' | 'default';
};

export function protectedView(
  store: ClientStore,
  reference: Permission,
  data?: unknown,
  tenant?: string,
  _generation?: number,
): ProtectedView {
  const local: PermissionState = store.permissionState(reference, data);
  const scoped: ProtectedView =
    tenant === undefined
      ? {
          allowed: local.allowed,
          status: local.status,
          decision: local.decision,
          slot: slotOf(local.allowed, local.status, local.decision),
        }
      : tenantView(store.get().tenant(tenant) as DecideDock, reference, data);
  return scoped;
}

function tenantView(
  dock: DecideDock,
  reference: Permission,
  data: unknown,
): ProtectedView {
  const decision = dock.decide(reference, data);
  const allowed = decision.outcome === 'granted';
  return {
    allowed,
    status: 'ready',
    decision,
    slot: slotOf(allowed, 'ready', decision),
  };
}

function slotOf(
  allowed: boolean,
  status: ClientStatus,
  decision: Decision,
): ProtectedView['slot'] {
  if (status === 'pending') {
    return 'pending';
  }
  if (!allowed || decision.outcome !== 'granted') {
    return 'fallback';
  }
  return 'default';
}
