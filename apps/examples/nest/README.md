# `@permdock/example-nest`

Minimal Nest wiring for `permdock/nest`: `definePermissions`, `definePolicy`, `createPermDock`, `Protect` on `PATCH /posts/:id` (granted) and `POST /posts/:id/publish` (denied for `member`).

```ts
import { createPermDock } from 'permdock/nest'
```
