---
'permdock': minor
'@permdock/cli': patch
---

Raise optional peers to `@orpc/server` 2.x (beta) and `@nestjs/*` 12, and bump `@permdock/cli`'s unplugin to 3. `permdock()` on oRPC is a no-op when `context.permdock` is already set, matching oRPC 2's removal of automatic middleware dedupe.
