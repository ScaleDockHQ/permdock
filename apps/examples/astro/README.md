# `@permdock/example-astro`

Astro 7 wiring for `permdock/astro`: `onRequest = middleware()` in `src/middleware.ts`, `protect` on `PATCH /api/posts/[id]` (granted) and `POST /api/posts/[id]/publish` (denied for `member`), and the decision endpoint at `src/pages/api/permdock.ts`. `output: "server"` renders every route on demand. `pnpm dev` serves `127.0.0.1:3486`; a production build needs an adapter such as `@astrojs/node`.

```ts
import { createPermDock } from "permdock/astro";
```
