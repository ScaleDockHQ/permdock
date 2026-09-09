# `@permdock/example-react-vite`

Minimal React wiring for `permdock/react`: a Snapshot v2 built in the app, `PermDockProvider`, and `<Protected>` guards. Vite serves the page.

```bash
pnpm --filter @permdock/example-react-vite dev
```

Opens `http://127.0.0.1:3480/`. `Protected` shows `edit` for a member updating their own post and `locked` for publish.

```ts
import { PermDockProvider, Protected } from 'permdock/react'
```
