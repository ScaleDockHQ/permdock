import { allow, definePolicy, role } from 'permdock';

import { permissions } from './permissions.ts';

export type User = {
  readonly id: string;
};

const editor = role('editor', [allow(permissions.post.read)], {
  on: 'tenant',
});

export const policy = definePolicy(permissions, {
  roles: [editor],
  scopes: { tenant: { key: 'orgId' } },
  subject: (user: User | null) => (user === null ? null : { id: user.id }),
});
