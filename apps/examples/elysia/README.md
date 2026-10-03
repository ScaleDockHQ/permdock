# `@permdock/example-elysia`

Minimal Elysia wiring for `permdock/elysia`: `definePermissions`, `definePolicy`, `createPermDock`, `protect` on `PATCH /posts/:id` (granted) and `POST /posts/:id/publish` (denied for `member`).

```ts
import { createPermDock } from "permdock/elysia";
```
