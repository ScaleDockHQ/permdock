import { Tabs } from "expo-router";
import { PermDockProvider, usePermission } from "permdock/react-native";

import { source } from "../local.ts";
import { ownPost, permissions } from "../permissions.ts";
import { storage } from "../storage.ts";

function AppTabs() {
  const publish = usePermission(permissions.post.publish, ownPost);
  return (
    <Tabs>
      <Tabs.Screen name="index" options={{ title: "Posts" }} />
      <Tabs.Protected guard={publish.allowed}>
        <Tabs.Screen name="publish" options={{ title: "Publish" }} />
      </Tabs.Protected>
    </Tabs>
  );
}

export default function Layout() {
  return (
    <PermDockProvider storage={storage} source={source}>
      <AppTabs />
    </PermDockProvider>
  );
}
