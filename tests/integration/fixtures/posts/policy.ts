import { allow, definePolicy, principal, role, sqlFunction } from 'permdock';

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
          where: { authorId: principal.id },
        }),
        allow(permissions.job.read, {
          where: sqlFunction('job_permitted', {
            args: [{ field: 'id' }],
            twin: {
              or: [
                { scope: 'public' },
                {
                  and: [
                    { scope: 'team' },
                    {
                      op: 'memberOf',
                      scope: 'team',
                      field: 'teamId',
                      roles: [],
                    },
                  ],
                },
              ],
            },
          }),
        }),
      ]),
    ],
    principal: (user: User | null) => user,
  },
);
