# `@permdock/example-expo`

Expo Router wiring for `permdock/react-native`: `expo-secure-store` storage on iOS and Android (`memoryStorage` on web), a `localSnapshot` built from rows on the device, `Tabs.Protected` and `Protected`. The policy never reaches the app bundle: `pnpm gen` writes `src/permdock-manifest.json` from it, and `pnpm gen:check` fails when the file is stale.

```bash
pnpm --filter @permdock/example-expo dev
```

Opens `http://127.0.0.1:3486/`. The member sees `edit`, `locked` for publish and one tab. "Sync admin role" changes the local row: `publish` unlocks and the Publish tab appears without a network request.

```ts
import {
  localSnapshot,
  PermDockProvider,
  usePermission,
} from "permdock/react-native";
```
