import { Slot } from 'expo-router';
import { memoryStorage, PermDockProvider } from 'permdock/react-native';

import { memberSnapshot } from '../snapshot.ts';

const storage = memoryStorage();

export default function Layout() {
  return (
    <PermDockProvider storage={storage} snapshot={memberSnapshot}>
      <Slot />
    </PermDockProvider>
  );
}
