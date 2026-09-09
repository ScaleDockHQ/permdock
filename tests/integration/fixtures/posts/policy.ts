import { allow, definePolicy, role, subject } from 'permdock';

import { permissions } from './permissions.ts';

export type User = {
  readonly id: string;
  readonly roles: readonly string[];
};

export const policy = definePolicy(permissions, {
  roles: [
    role('member', [
      allow(permissions.post.read),
      allow(permissions.post.list),
      allow(permissions.post.create),
      allow(permissions.post.update, { where: { authorId: subject.id } }),
    ]),
  ],
  subject: (user: User | null) => user,
});
