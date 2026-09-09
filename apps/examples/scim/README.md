# `@permdock/example-scim`

Hono mount of `scimHandler` over `memoryDirectoryStore`, with `directoryMembershipSource` feeding `createPermDock`. `GET /health` is open; `GET /scim/v2/Users` without a bearer token is denied. `src/replay.ts` replays create-user, add-to-group and deactivate and checks a tenant-scoped `can`. `pnpm start` listens on `127.0.0.1:3476`.

```ts
import { scimHandler, memoryDirectoryStore, directoryMembershipSource } from 'permdock/scim'
```
