# `@permdock/example-sveltekit`

SvelteKit 3 wiring for `permdock/sveltekit`: `handle = middleware()` in `src/hooks.server.ts`, `protect` on `PATCH /api/posts/[id]` (granted) and `POST /api/posts/[id]/publish` (denied for `member`), and the decision endpoint at `src/routes/api/permdock/+server.ts`. `pnpm dev` serves `127.0.0.1:3485`.

```ts
import { createPermDock } from "permdock/sveltekit";
```
