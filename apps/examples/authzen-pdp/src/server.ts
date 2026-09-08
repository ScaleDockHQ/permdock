import type { Policy } from 'permdock';

import { createPermDock } from 'permdock/authzen';

import { otherPost, ownPost } from './permissions.ts';
import { adminUser, memberUser, policy } from './policy.ts';

const posts = new Map<string, typeof ownPost>([
  [ownPost.id, ownPost],
  [otherPost.id, otherPost],
]);

export const { handler } = createPermDock(policy as Policy, {
  subject: (request) => {
    const authorization = request.headers.get('authorization');
    return authorization === 'Bearer test' ? memberUser : null;
  },
  resources: {
    post: {
      load: (id) => posts.get(id) ?? null,
      list: () => [...posts.values()],
    },
  },
  subjects: {
    list: () => [memberUser, adminUser],
  },
});
