import {
  memoryStorage,
  PermDockProvider,
  usePermission,
} from 'permdock/react-native';

import { ownPost, permissions } from './permissions.ts';

const storage = memoryStorage();

function AdminGuard() {
  const { allowed } = usePermission(permissions.post.update, ownPost);
  return allowed ? 'edit' : 'locked';
}

export function App() {
  return (
    <PermDockProvider
      storage={storage}
      snapshotUrl="https://api.example.com/permdock/snapshot"
    >
      <AdminGuard />
    </PermDockProvider>
  );
}
