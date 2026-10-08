import { Tabs } from "expo-router";
import * as SecureStore from "expo-secure-store";
import {
  appStateForeground,
  memoryStorage,
  PermDockProvider,
  secureStoreStorage,
  usePermissionGuard,
} from "permdock/react-native";
import { AppState, Platform } from "react-native";

import { source, user } from "../local.ts";
import { ownPost, permissions } from "../permissions.ts";

// expo-secure-store has no web implementation; the web build keeps the snapshot in memory.
const storage =
  Platform.OS === "web" ? memoryStorage() : secureStoreStorage(SecureStore);
// Rows another device changed arrive while the app is in the background.
const foreground = appStateForeground(AppState);

// JS tabs, not `expo-router/unstable-native-tabs`: SDK 57 native tabs have no web view, and toggling
// `hidden` when a role syncs remounts the navigator and resets its state.
function AppTabs() {
  return (
    <Tabs>
      <Tabs.Screen name="index" options={{ title: "Posts" }} />
      <Tabs.Protected
        guard={usePermissionGuard(permissions.post.publish, ownPost)}
      >
        <Tabs.Screen name="publish" options={{ title: "Publish" }} />
      </Tabs.Protected>
    </Tabs>
  );
}

export default function Layout() {
  return (
    <PermDockProvider
      storage={storage}
      source={source}
      subjectId={user.id}
      subscribeForeground={foreground}
    >
      <AppTabs />
    </PermDockProvider>
  );
}
