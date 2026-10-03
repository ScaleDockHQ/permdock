# `@permdock/example-convex`

Hono stand-in for `permdock/convex`: `withPermDock` on `GET /posts` (granted `filter` rows) and `POST /posts/:id/delete` (denied for `member`). `pnpm start` listens on `127.0.0.1:3465`.

```ts
import { createPermDock } from "permdock/convex";
```
