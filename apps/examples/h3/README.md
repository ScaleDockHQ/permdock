# `@permdock/example-h3`

Minimal h3 v2 wiring for `permdock/h3`: `middleware()` on the app, `protect` as route middleware on `PATCH /posts/:id` (granted) and `POST /posts/:id/publish` (denied for `member`), `withPermDock` for the typed row, and the decision endpoint at `/api/permdock`. `pnpm start` listens on `127.0.0.1:3457`.

```ts
import { createPermDock } from "permdock/h3";
```
