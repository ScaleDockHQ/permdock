import { createPermDock, type Decision, type Permission } from 'permdock';

import { memberUser, policy } from '../policy.ts';

const DENIED: Decision = {
  outcome: 'denied',
  denials: [{ role: null, reason: 'no-grant' }],
  alternatives: [],
};

const dock = await Promise.resolve(createPermDock(policy, memberUser));

export function getPermDock() {
  return dock;
}

export function getPermission(permission: Permission, data?: unknown) {
  try {
    const decision = (
      dock.decide as (next: Permission, row?: unknown) => Decision
    )(permission, data);
    return {
      allowed: decision.outcome === 'granted',
      status: 'ready' as const,
      decision,
    };
  } catch {
    return { allowed: false, status: 'ready' as const, decision: DENIED };
  }
}
