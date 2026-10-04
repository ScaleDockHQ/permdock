# `@permdock/example-next`

`permdock/next` on Next.js 16.3 with Cache Components, Partial Prefetching and instant navigation. A field-service app on named scopes: organizations (`acme`, `globex`) with staff roles, and customers inside them whose portal contacts see only their own quotes.

```bash
pnpm --filter @permdock/example-next build
pnpm --filter @permdock/example-next start
```

Opens `http://127.0.0.1:3485/`. Prefetching happens only under `next start`; `dev` works too but every navigation reaches the server.

Sign in as:

- **Olivia**, admin of Acme and member of Globex: sees Members and Settings in Acme, can approve and delete quotes, and can change roles (including her own).
- **Max**, member of Acme: reads quotes; `/acme/settings` renders the forbidden page.
- **Carol**, contact of the Northwind customer: lands on `/portal/acme` and sees only Northwind's sent and approved quotes.

Where things live:

- `src/permdock/server.ts`: `createPermDock` from `permdock/next` (`getPermDock`, `getPermission`, `requireAccess`, `permdockHandler`).
- `src/lib/access.ts`: the app-owned caches. `loadSnapshot` and `quoteAccess` are `'use cache: private'`, so the gated nav and a quote's actions ride the prefetch.
- `src/app/actions.ts`: Server Actions guarded by `requireAccess`, then `updateTag`.
- `src/app/[org]/settings/page.tsx`: `prefetch = 'force-disabled'`, `instant = false` and `requireAccess` at the top.
- `src/app/offline-badge.tsx`: `useOffline`; the snapshot keeps answering offline.

Set `SESSION_SECRET` in any deployment; the demo falls back to a fixed secret.
