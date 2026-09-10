# `@permdock/example-svelte`

Minimal Svelte wiring for `permdock/svelte`: a Snapshot v3 built in the app, `setPermDock`, and `<Protected>` guards. Vite serves the page.

```bash
pnpm --filter @permdock/example-svelte dev
```

Opens `http://127.0.0.1:3482/`. `Protected` shows `edit` for a member updating their own post and `locked` for publish.

```ts
import { Protected, permission, setPermDock } from 'permdock/svelte'
```
