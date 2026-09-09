# `@permdock/example-nest`

Minimal Nest wiring for `permdock/nest`: `definePermissions`, `definePolicy`, `createPermDock`, `Protect` on `PATCH /posts/:id` (granted) and `POST /posts/:id/publish` (denied for `member`). `pnpm start` listens on `127.0.0.1:3460`.

```ts
import { createPermDock } from 'permdock/nest'
```
