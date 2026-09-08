# `@permdock/example-trpc`

Minimal tRPC wiring for `permdock/trpc`: `definePermissions`, `definePolicy`, `createPermDock`, `protect` on `posts.update` (granted) and `posts.publish` (denied for `member`). `pnpm start` listens on `127.0.0.1:3461`.

```ts
import { createPermDock } from 'permdock/trpc'
```
