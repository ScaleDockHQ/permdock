import {
  allow,
  createPermDock,
  definePermissions,
  definePolicy,
  resource,
  role,
  subject,
} from 'permdock';
import { z } from 'zod';

const Post = z.object({
  id: z.string(),
  authorId: z.string(),
});

export const permissions = definePermissions({
  post: resource(Post, {
    id: 'id',
    actions: ['read', 'update', 'delete'],
    collection: ['list', 'create'],
  }),
});

const member = role('member', [
  allow(permissions.post.read),
  allow(permissions.post.list),
  allow(permissions.post.update, { where: { authorId: subject.id } }),
]);

export const policy = definePolicy(permissions, {
  roles: [member],
  subject: (
    user: { readonly id: string; readonly roles: readonly string[] } | null,
  ) => user,
});

export async function check(): Promise<boolean> {
  const dock = await createPermDock(policy, {
    id: 'u1',
    roles: ['member'],
  });
  return dock.can(permissions.post.list);
}
