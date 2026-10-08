# `@permdock/example-solid`

Minimal Solid wiring for `permdock/solid`: a Snapshot v3 built in the app, `PermDockProvider`, and `<Protected>` guards. Vite serves the page.

```bash
pnpm --filter @permdock/example-solid dev
```

Opens `http://127.0.0.1:3483/`. `Protected` shows `edit` for a member updating their own post. `usePermission` shows `ask to delete`, because deleting needs approval. `PermissionBoundary` catches the publish panel's `assert` and shows `no post.publish`.

```ts
import { PermDockProvider, Protected } from "permdock/solid";
```
