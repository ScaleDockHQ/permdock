# `@permdock/example-scim`

Hono mount of `scimHandler` over `memoryDirectoryStore`, with `directoryMembershipSource` feeding `createPermDock`. `src/replay.ts` replays create-user, add-to-group and deactivate and checks a tenant-scoped `can`.

```ts
import { scimHandler, memoryDirectoryStore, directoryMembershipSource } from 'permdock/scim'
```
