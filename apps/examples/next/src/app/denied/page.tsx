import { getPermission } from '../../permdock/server.ts';
import { otherPost, permissions } from '../../permissions.ts';

export default async function DeniedPage() {
  const { allowed } = await getPermission(permissions.post.update, otherPost);
  return allowed ? 'edit' : 'locked';
}
