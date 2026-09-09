# `@permdock/example-next`

Minimal Next.js wiring: `definePermissions`, `definePolicy`, `createPermDock`, and `getPermission` guards on App Router pages.

```bash
pnpm --filter @permdock/example-next dev
```

Opens `http://127.0.0.1:3485/`. `/` shows `edit` for a member updating their own post. `/denied` shows `locked` for someone else's post.

```ts
import { createPermDock } from 'permdock'
```
