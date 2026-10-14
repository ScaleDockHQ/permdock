# `@permdock/example-solid-start`

SolidStart 2 wiring for `permdock/solid-start`: `middleware()` in the h3 middleware list of `src/middleware.ts`, `protect` on the API routes `PATCH /api/posts/[id]` (granted) and `POST /api/posts/[id]/publish` (denied for `member`), and the decision endpoint at `src/routes/api/permdock.ts`. `pnpm dev` serves `127.0.0.1:3487`.

```ts
import { createPermDock } from "permdock/solid-start";
```
