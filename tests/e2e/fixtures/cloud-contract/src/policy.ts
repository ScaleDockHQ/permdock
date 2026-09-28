import { allow, definePolicy, principal, role } from 'permdock';

import { permissions } from './permissions.ts';

export type User = {
  readonly id: string;
  readonly roles: readonly string[];
};

export const policy = definePolicy(permissions, {
  roles: [
    role(
      'member',
      [
        allow(permissions.invoice.read, { where: { ownerId: principal.id } }),
        allow(permissions.invoice.list),
      ],
      { assignable: true },
    ),
    role(
      'finance',
      [
        allow(permissions.invoice.read),
        allow(permissions.invoice.refund, { approval: 'human' }),
      ],
      { assignable: true },
    ),
    role('auditor', [], { assignable: true }),
  ],
  principal: (user: User) => user,
  hostable: [permissions.auditLog.read],
});
