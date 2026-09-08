# `@permdock/example-orpc`

Minimal oRPC wiring for `permdock/orpc`: `definePermissions`, `definePolicy`, `createPermDock`, `protect` on `posts.update` (granted) and `posts.publish` (denied for `member`). `pnpm start` listens on `127.0.0.1:3462`.

```ts
import { createPermDock } from 'permdock/orpc'
```
