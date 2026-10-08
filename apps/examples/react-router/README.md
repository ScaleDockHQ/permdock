# `@permdock/example-react-router`

React Router 8 in framework mode: the root `loader` calls `getSnapshot(request)` from `permdock/server`, sends `snapshotHeaders(snapshot)`, and hands the snapshot to `PermDockProvider` from `permdock/react`. The `/api/permdock` action serves the decision endpoint.

```bash
pnpm --filter @permdock/example-react-router dev
```

Opens `http://127.0.0.1:3484/`. `Protected` shows `edit` for a member updating their own post and `locked` for publish. `usePermission` shows `ask to delete`, because deleting needs approval.

```ts
import { getSnapshot, snapshotHeaders } from "permdock/server";
```
