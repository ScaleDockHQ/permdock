# `@permdock/example-express`

Minimal Express wiring for `permdock/express`: `definePermissions`, `definePolicy`, `createPermDock`, `protect` on `PATCH /posts/:id` (granted) and `POST /posts/:id/publish` (denied for `member`).

```ts
import { createPermDock } from 'permdock/express'
```
