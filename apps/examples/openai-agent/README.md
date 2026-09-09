# `@permdock/example-openai-agent`

HTTP harness for `permdock/openai`. `pnpm start` listens on `127.0.0.1:3475` with no OpenAI API key.

- `GET /health`
- `GET /list_posts` — `needsApproval` → `false` (run)
- `GET /delete_post` — `needsApproval` → `true` (pause)

```ts
import { createPermDock } from 'permdock/openai'
```
