# `@permdock/example-claude-agent`

HTTP harness for `permdock/claude-agent`. `pnpm start` listens on `127.0.0.1:3473` with no Anthropic API key.

- `GET /health`
- `GET /list_posts` — `canUseTool` → allow
- `GET /delete_post` — `canUseTool` → `null` (ask via `PermissionRequest`)

```ts
import { createPermDock } from 'permdock/claude-agent'
```
