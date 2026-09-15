import { allow, definePolicy, principal, role } from 'permdock';

import { permissions } from './permissions.ts';

export const policy = definePolicy(permissions, {
  roles: [
    role(
      'org:admin',
      [
        allow(permissions.post.read),
        allow(permissions.post.update),
        allow(permissions.post.delete),
      ],
      { on: 'tenant' },
    ),
    role(
      'org:member',
      [
        allow(permissions.post.read),
        allow(permissions.post.update, { where: { authorId: principal.id } }),
      ],
      { on: 'tenant' },
    ),
    role('org:invoices:create', [allow(permissions.post.list)], {
      on: 'tenant',
    }),
  ],
  subject: () => null,
  scopes: { tenant: { key: 'orgId' } },
  validate: 'boundary',
});
