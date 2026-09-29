import { allow, anyone, breakGlass, definePolicy, deny, role } from 'permdock';

import { permissions } from './permissions.ts';

export const policy = definePolicy(permissions, {
  roles: [role('nurse', [allow(permissions.patient.read)])],
  grants: [
    deny(permissions.patient.read, {
      to: anyone(),
      where: { restricted: { eq: true } },
      name: 'restricted-record',
    }),
    breakGlass(permissions.patient.read, {
      overrides: ['restricted-record'],
      requires: { purpose: ['BTG', 'ETREAT'], reason: true },
      maxDuration: '1h',
      obligations: ['notify', 'review'],
    }),
  ],
  principal: (user: { readonly id: string } | null) => user,
});
