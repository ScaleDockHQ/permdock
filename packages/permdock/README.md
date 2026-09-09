# permdock

Typed permissions for TypeScript apps, APIs, databases, and AI agents.

```ts
import { createPermDock, definePermissions, definePolicy } from 'permdock';
import { createPermDock as createHonoPermDock } from 'permdock/hono';
import { PermDockProvider, Protected } from 'permdock/react';
```

This package is the umbrella entry. Core lives at `permdock`; every adapter is a subpath (`permdock/react`, `permdock/hono`, `permdock/next`, `permdock/ai-sdk`, …). Optional framework peers stay optional: structurally typed providers (`supabase`, `clerk`, `better-auth`, `convex`, `prisma`, `mcp`, `react-native`) declare no peer so you do not install a fake SDK.

See the [docs](https://permdock.dev/docs) and the [quick start](https://permdock.dev/docs/getting-started/quick-start).
