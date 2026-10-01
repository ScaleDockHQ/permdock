import { createPermDock } from 'permdock';

import { permissions } from './permissions.ts';
import { policy } from './policy.ts';

const permdock = await createPermDock(policy, {
  id: 'u1',
  orgId: 'o1',
  roles: ['member'],
});

export function updateOwn(): boolean {
  return permdock.can(permissions.post.update, {
    id: 'p1',
    authorId: 'u1',
    orgId: 'o1',
    published: false,
  });
}

export function archiveOwn(): boolean {
  return permdock.can(permissions.post.archive, {
    id: 'p1',
    authorId: 'u1',
    orgId: 'o1',
    published: false,
  });
}
