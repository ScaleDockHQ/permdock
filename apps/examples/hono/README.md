# `@permdock/example-hono`

Minimal Hono wiring for `permdock/hono`: `definePermissions`, `definePolicy`, `createPermDock`, `protect` on `PATCH /posts/:id` (granted) and `POST /posts/:id/publish` (denied for `member`). `pnpm start` listens on `127.0.0.1:3456` for `tests/e2e`.

```ts
import { createPermDock } from "permdock/hono";
```
