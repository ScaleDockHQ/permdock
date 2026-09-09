# `@permdock/example-webmcp`

Minimal React wiring for `permdock/webmcp`: a Snapshot v2 built in the app, `usePermDock()`, and `registerTools` against an in-memory `document.modelContext`. Vite serves the page.

```bash
pnpm --filter @permdock/example-webmcp dev
```

Opens `http://127.0.0.1:3484/`. The registered tool list includes snapshot-allowed tools (`post_read`, `post_update`, `post_create`, `post_list`, `post_delete`) and excludes `post_publish`. Serve the page with a `Permissions-Policy: tools=*` header when using a native or polyfill `document.modelContext`.

```ts
import { registerTools } from 'permdock/webmcp'
```
