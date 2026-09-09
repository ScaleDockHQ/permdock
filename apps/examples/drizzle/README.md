# `@permdock/example-drizzle`

Hono wiring for `permdock/drizzle`: `toWhere` on `GET /posts` (granted, `ok` is true) and `POST /posts/:id/publish` (denied for `member` via `can`). `pnpm start` listens on `127.0.0.1:3466`.

```ts
import { toWhere } from 'permdock/drizzle'
```
