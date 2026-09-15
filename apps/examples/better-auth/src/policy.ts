import { allow, definePolicy, principal, role } from 'permdock';
import { rolesFromAccessControl } from 'permdock/better-auth';

import { permissions } from './permissions.ts';

const seeded = rolesFromAccessControl(
  {
    ac: {},
    roles: {
      member: { statements: { post: ['read', 'create', 'list'] } },
      admin: {
        statements: { post: ['read', 'create', 'list', 'update', 'delete'] },
      },
    },
  },
  permissions,
  { on: 'tenant' },
);

export const policy = definePolicy(permissions, {
  roles: [
    ...seeded,
    role(
      'member',
      [allow(permissions.post.update, { where: { authorId: principal.id } })],
      { on: 'tenant' },
    ),
    role('support', [allow(permissions.post.read)]),
  ],
  subject: () => null,
  scopes: { tenant: { key: 'organizationId' }, team: { key: 'teamId' } },
  validate: 'boundary',
});
