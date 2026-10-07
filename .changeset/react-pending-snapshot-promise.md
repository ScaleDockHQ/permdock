---
"permdock": minor
---

Breaking: `PermDockProvider` from `permdock/react` no longer suspends its readers on a `snapshotPromise`. Until the promise resolves, `usePermission`, `usePermissions`, `usePermDock` and the other hooks answer from the current snapshot with `status: 'pending'` (an empty snapshot denies), `<Protected>` renders its `pending` slot, and the store re-renders the readers when the promise settles. Permission UI therefore stays in the Next.js Cache Components static shell, as the guide describes. A promise React has already settled hydrates before paint, and a rejection fails closed with `status: 'server-only'` instead of reaching an error boundary. To keep the previous behavior, pass `suspend` to `PermDockProvider` from `permdock/react` or `permdock/next`.
