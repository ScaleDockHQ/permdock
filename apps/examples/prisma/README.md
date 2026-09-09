# `@permdock/example-prisma`

Hono wiring for `permdock/prisma`: `toWhere` on `GET /posts` (granted, `where` is truthy) and `POST /posts/:id/publish` (denied for `member` via `can`). `pnpm start` listens on `127.0.0.1:3468`.

```ts
import { toWhere } from 'permdock/prisma'
```
