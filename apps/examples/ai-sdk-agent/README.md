# `@permdock/example-ai-sdk-agent`

HTTP harness for `permdock/ai-sdk`. `pnpm start` listens on `127.0.0.1:3472` with no model API key.

- `GET /health`
- `GET /list_posts` — `toolApproval` → `approved`
- `GET /delete_post` — `toolApproval` → `user-approval`
- `GET /publish_post` — `toolApproval` → `user-approval` with `stepUp: { kind: 'authentication', acrValues: ['mfa'], maxAge: 300 }`; publishing needs an MFA sign-in from the last five minutes

```ts
import { createPermDock } from "permdock/ai-sdk";
```
