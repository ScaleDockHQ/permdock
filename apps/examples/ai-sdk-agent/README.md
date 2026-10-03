# `@permdock/example-ai-sdk-agent`

HTTP harness for `permdock/ai-sdk`. `pnpm start` listens on `127.0.0.1:3472` with no model API key.

- `GET /health`
- `GET /list_posts` — `toolApproval` → `approved`
- `GET /delete_post` — `toolApproval` → `user-approval`

```ts
import { createPermDock } from "permdock/ai-sdk";
```
