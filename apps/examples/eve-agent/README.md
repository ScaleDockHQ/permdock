# `@permdock/example-eve-agent`

HTTP harness for `permdock/eve`. `pnpm start` listens on `127.0.0.1:3474` with no model API key. This app is also the intended PermDock Cloud Marketplace template.

- `GET /health`
- `GET /list_posts` — `approval.request` → `not-applicable`
- `GET /delete_post` — `approval.request` → `user-approval`

```ts
import { createPermDock } from 'permdock/eve'
```
