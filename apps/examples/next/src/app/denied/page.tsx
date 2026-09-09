import { getPermission } from '../../permdock/server.ts';
import { otherPost, permissions } from '../../permissions.ts';

export default function DeniedPage() {
  const { allowed } = getPermission(permissions.post.update, otherPost);
  return allowed ? 'edit' : 'locked';
}
