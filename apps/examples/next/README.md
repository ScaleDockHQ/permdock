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
- `src/app/[org]/access-summary.tsx`: `usePermission` in the static shell, without a Suspense boundary; it shows `pending` until the snapshot lands.
- `src/components/ui`: shadcn/ui (`base-vega`, Tailwind CSS 4), vendored with `pnpm dlx shadcn@latest add <name>` from this folder.

Every store read waits 3 s, so a cached read and a prefetched navigation stand out from a cold one. Each list and card has a footer with how long its read took and when it ran; a cache hit keeps both. Set `DEMO_LATENCY_MS` to change the delay, or to `0` to turn it off.

Set `SESSION_SECRET` in any deployment; the demo falls back to a fixed secret.

## Verify instant navigation

```bash
pnpm --filter @permdock/example-next test:instant
```

Builds the app with `EXPOSE_TESTING_API=1`, serves it on `http://127.0.0.1:3585`, and runs `tests/instant/*.instant.ts` with `instant()` from `@next/playwright` at 1280 px and 390 px. The specs cover the initial load of `/acme` and `/portal/acme`, the soft navigation from Overview to Quotes, the organization switch, and the per-link prefetch of a quote and the Members page. `cold-then-warm.instant.ts` reads Quotes and `q-101` once, then checks that a reload and a revisit show the same read time under the lock. Under the lock each spec expects the shell and the skeleton, and expects the deferred list to be absent. Install Chromium once with `pnpm --filter @permdock/example-next exec playwright install chromium`.
