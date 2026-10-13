# `@permdock/example-tanstack-start`

TanStack Start wiring for `permdock/tanstack-start`: `middleware()` in `requestMiddleware` of `src/start.ts`, `protect` as server route middleware on `PATCH /api/posts/$id` (granted) and `POST /api/posts/$id/publish` (denied for `member`), and the decision endpoint at `src/routes/api/permdock.ts`. `pnpm dev` serves `127.0.0.1:3488` and regenerates `src/routeTree.gen.ts`.

```ts
import { createPermDock } from "permdock/tanstack-start";
```
