# `@permdock/example-fastify`

Minimal Fastify wiring for `permdock/fastify`: `definePermissions`, `definePolicy`, `createPermDock`, `protect` on `PATCH /posts/:id` (granted) and `POST /posts/:id/publish` (denied for `member`).

```ts
import { createPermDock } from "permdock/fastify";
```
