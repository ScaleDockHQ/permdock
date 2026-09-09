# `@permdock/example-a2a-agent`

Hono wiring for `permdock/a2a`. `pnpm start` listens on `127.0.0.1:3471`.

- `GET /health`
- `GET /.well-known/agent-card.json`
- `POST /a2a/tasks` — summarise granted for a member; publish denied

```ts
import { createPermDock } from 'permdock/a2a'
```
