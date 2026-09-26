# `@permdock/example-prisma`

Hono wiring for `permdock/prisma` on Prisma 7 with `@prisma/adapter-pg`, connected to an in-process [PGlite](https://pglite.dev) database through `@electric-sql/pglite-socket`. `GET /posts` runs `findMany({ where: toWhere(dock.where(permissions.post.list), { requiredFields }) })`; `PATCH /posts/:id` runs `updateMany` with the update filter and answers 403 when no row matched; `POST /posts/:id/publish` is denied for `member` via `can`. `requiredFields` lists the non-nullable columns, because Prisma rejects a null filter on them. `pnpm start` runs `prisma generate` and listens on `127.0.0.1:3468`.

```ts
import { permdockExtension, toWhere } from 'permdock/prisma'
```
