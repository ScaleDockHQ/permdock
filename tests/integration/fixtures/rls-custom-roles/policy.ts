import { allow, definePolicy, deny, principal, role } from 'permdock';

import { permissions } from './permissions.ts';

const { board, project, task } = permissions;

export const policy = definePolicy(permissions, {
  roles: [
    role('auditor', [allow([project.read, task.read])]),
    role('owner', [allow(project.delete)], {
      on: 'tenant',
      assignable: false,
    }),
    role(
      'admin',
      [
        allow([project.read, project.update]),
        allow([task.read, task.update, task.delete]),
      ],
      { on: 'tenant' },
    ),
    role(
      'member',
      [
        allow([project.read, task.read]),
        allow(project.update, { where: { ownerId: principal.id } }),
        allow([task.update, task.delete], {
          where: { authorId: principal.id },
        }),
        deny(task.update, { where: { locked: true } }),
      ],
      { on: 'tenant' },
    ),
    role('viewer', [allow([project.read, task.read])], { on: 'tenant' }),
    role('lead', [allow([board.read, board.update])], { on: 'team' }),
  ],
  scopes: {
    tenant: { key: 'orgId' },
    team: { key: 'teamId', within: 'tenant' },
  },
  subject: () => null,
});
