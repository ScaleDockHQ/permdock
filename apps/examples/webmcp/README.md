# `@permdock/example-webmcp`

Minimal React wiring for `permdock/webmcp`: a server-built Snapshot v2, `usePermDock()`, and `registerTools` against an in-memory `document.modelContext`. Vite is the intended bundler; this package typechecks the source. Serve the page with a `Permissions-Policy: tools=*` header when using a native or polyfill `document.modelContext`.

```ts
import { registerTools } from 'permdock/webmcp'
```
