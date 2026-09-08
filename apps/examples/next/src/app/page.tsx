import { getPermission } from '../permdock/server.ts';
import { ownPost, permissions } from '../permissions.ts';

export default async function Page() {
  const { allowed } = await getPermission(permissions.post.update, ownPost);
  return allowed ? 'edit' : 'locked';
}
