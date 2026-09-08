import type { ReactNode } from 'react';

import type { Decision } from '../core/decision.ts';
import type { Permission } from '../core/permissions.ts';
import type { ClientStatus, ProtectedProps } from './types.ts';

import { usePermission, usePermDock } from './hooks.ts';

export function Protected(props: ProtectedProps): ReactNode {
  const root = usePermDock();
  const local = usePermission(props.permission, props.data);
  const run = (dock: {
    readonly decide: (permission: Permission, data?: unknown) => Decision;
  }): {
    readonly allowed: boolean;
    readonly status: ClientStatus;
    readonly decision: Decision;
  } => {
    const decision = dock.decide(props.permission, props.data);
    return {
      allowed: decision.outcome === 'granted',
      status: 'ready',
      decision,
    };
  };
  const { allowed, status, decision } =
    props.tenant === undefined
      ? local
      : run(
          root.tenant(props.tenant) as {
            readonly decide: (
              permission: Permission,
              data?: unknown,
            ) => Decision;
          },
        );
  if (status === 'pending') {
    return props.pending ?? null;
  }
  if (!allowed || decision.outcome !== 'granted') {
    if (typeof props.fallback === 'function') {
      return props.fallback(decision);
    }
    return props.fallback ?? null;
  }
  if (typeof props.children === 'function') {
    return props.children(decision);
  }
  return props.children;
}
