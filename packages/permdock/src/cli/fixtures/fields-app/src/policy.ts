import { allow, anyone, definePolicy, deny, principal, role } from 'permdock';

import { permissions } from './permissions.ts';

const { invoice } = permissions;

export const policy = definePolicy(permissions, {
  roles: [
    role('admin', [allow([invoice.read, invoice.update])], { on: 'tenant' }),
    role(
      'finance',
      [allow(invoice.read, { fields: ['id', 'orgId', 'title', 'amount'] })],
      { on: 'tenant' },
    ),
    role(
      'member',
      [
        allow(invoice.read, { fields: ['id', 'orgId', 'authorId', 'title'] }),
        allow(invoice.read, { where: { authorId: principal.id } }),
      ],
      { on: 'tenant' },
    ),
    role('auditor', [
      allow(invoice.read),
      deny(invoice.read, { fields: ['note'] }),
    ]),
  ],
  grants: [
    allow(invoice.read, {
      to: anyone(),
      where: { orgId: 'public' },
      fields: ['id', 'title'],
    }),
  ],
  scopes: { tenant: { key: 'orgId' } },
  subject: () => null,
});
