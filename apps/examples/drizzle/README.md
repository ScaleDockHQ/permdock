# `@permdock/example-drizzle`

Hono wiring for `permdock/drizzle` over an in-process [PGlite](https://pglite.dev) database seeded with two posts. `GET /posts` runs `permdock()` from `permdock/hono` and selects through `toWhere(c.get('permdock').where(permissions.post.list), posts)`. `PATCH /posts/:id` runs `protect(permissions.post.update, loadPost)` and updates with the same filter, so another author's post answers 403 and a missing one 404, both as Problem Details. `POST /posts/:id/publish` is denied for `member` by `protect`. `pnpm start` listens on `127.0.0.1:3466`.

```ts
import { toWhere } from "permdock/drizzle";
```
