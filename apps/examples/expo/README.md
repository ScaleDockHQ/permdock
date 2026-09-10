# `@permdock/example-expo`

Minimal Expo Router wiring for `permdock/react-native`: an inline Snapshot v3, `memoryStorage`, and `Protected` / `usePermission`. Web is served by Expo.

```bash
pnpm --filter @permdock/example-expo dev
```

Opens `http://127.0.0.1:3486/`. `Protected` shows `edit` for a member updating their own post and `locked` for publish. Web smoke is Playwright; native Maestro is optional.

```ts
import { PermDockProvider, usePermission } from 'permdock/react-native'
```
