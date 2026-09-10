import { allow, definePolicy, relation, role } from 'permdock';

import { permissions, roles } from './permissions.ts';

export type User = {
  readonly id: string;
  readonly roles: readonly string[];
};

export const policy = definePolicy(
  { permissions, roles },
  {
    roles: [
      role(roles.member, [
        allow(permissions.post.read),
        allow(permissions.post.list),
        allow(permissions.post.create),
        allow(permissions.post.update, {
          to: relation(permissions.post, 'author'),
        }),
      ]),
    ],
    principal: (user: User | null) => user,
  },
);
