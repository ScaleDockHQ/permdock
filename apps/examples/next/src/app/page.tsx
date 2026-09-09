import { getPermission } from '../permdock/server.ts';
import { ownPost, permissions } from '../permissions.ts';

export default function Page() {
  const { allowed } = getPermission(permissions.post.update, ownPost);
  return allowed ? 'edit' : 'locked';
}
