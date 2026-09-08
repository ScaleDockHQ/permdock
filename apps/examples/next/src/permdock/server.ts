import type { Policy } from 'permdock';

import { createPermDock } from 'permdock/next';

import { memberUser, policy } from '../policy.ts';

export const { getPermDock, getPermission, PermDockProvider, permdockHandler } =
  createPermDock(policy as Policy, {
    subject: () => memberUser,
  });
