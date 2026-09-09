import { allow, definePolicy, role, subject } from 'permdock';

import { permissions } from './permissions.ts';

export type User = {
  readonly id: string;
  readonly orgId: string;
  readonly roles: readonly string[];
};

export const policy = definePolicy(permissions, {
  roles: [
    role('member', [
      allow(permissions.post.read),
      allow(permissions.post.list),
      allow(permissions.post.update, { where: { authorId: subject.id } }),
    ]),
  ],
  subject: (user: User | null) =>
    user === null
      ? null
      : { id: user.id, orgId: user.orgId, roles: user.roles },
  validate: 'boundary',
});

export const memberUser: User = { id: 'u1', orgId: 'o1', roles: ['member'] };
