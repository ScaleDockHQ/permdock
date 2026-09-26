# `@permdock/example-drizzle`

Hono wiring for `permdock/drizzle` over an in-process [PGlite](https://pglite.dev) database seeded with two posts. `GET /posts` selects through `toWhere(dock.where(permissions.post.list), posts)`; `PATCH /posts/:id` updates only when `toWhere(dock.where(permissions.post.update), posts)` matches (the member's own post), otherwise 403; `POST /posts/:id/publish` is denied for `member` via `can`. `pnpm start` listens on `127.0.0.1:3466`.

```ts
import { toWhere } from 'permdock/drizzle'
```
