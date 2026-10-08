# `@permdock/example-prisma`

Hono wiring for `permdock/prisma` on Prisma 7 with `@prisma/adapter-pg`, connected to an in-process [PGlite](https://pglite.dev) database through `@electric-sql/pglite-socket`. `GET /posts` runs `permdock()` from `permdock/hono` and `findMany({ where: toWhere(c.get('permdock').where(permissions.post.list), { requiredFields }) })`. `PATCH /posts/:id` runs `protect(permissions.post.update, loadPost)`, then `updateMany` with the update filter; another author's post answers 403 and a missing one 404, both as Problem Details. `POST /posts/:id/publish` is denied for `member` by `protect`. `requiredFields` lists the non-nullable columns, because Prisma rejects a null filter on them. `pnpm start` runs `prisma generate` and listens on `127.0.0.1:3468`.

```ts
import { permdockExtension, toWhere } from "permdock/prisma";
```
