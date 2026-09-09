# `@permdock/example-solid`

Minimal Solid wiring for `permdock/solid`: a Snapshot v2 built in the app, `PermDockProvider`, and `<Protected>` guards. Vite serves the page.

```bash
pnpm --filter @permdock/example-solid dev
```

Opens `http://127.0.0.1:3483/`. `Protected` shows `edit` for a member updating their own post and `locked` for publish.

```ts
import { PermDockProvider, Protected } from 'permdock/solid'
```
