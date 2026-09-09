import { allow, deny, role, subject } from 'permdock';

import { postPermissions } from './permissions.ts';

export const postRoles = [
  role('member', [
    allow(postPermissions.post.read),
    allow(postPermissions.post.list),
    allow(postPermissions.post.create),
    allow(postPermissions.post.update, { where: { authorId: subject.id } }),
    allow(postPermissions.post.delete, {
      where: { authorId: subject.id },
      approval: 'human',
    }),
  ]),
  role('admin', [
    allow(postPermissions.post.update),
    allow(postPermissions.post.delete),
    allow(postPermissions.post.publish),
    deny(postPermissions.post.publish, { where: { published: true } }),
  ]),
];
