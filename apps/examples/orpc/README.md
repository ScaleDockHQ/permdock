# `@permdock/example-orpc`

Minimal contract-first oRPC wiring for `permdock/orpc`: `definePermissions`, `definePolicy`, `createPermDock`, `protect` on `posts.update` (granted) and `posts.publish` (denied for `member`). `src/contract.ts` imports the permissions and `securityFor` from `permdock/openapi`, never the policy; `src/app.ts` implements it. `pnpm start` listens on `127.0.0.1:3462`.

```ts
import { createPermDock } from "permdock/orpc";
```
