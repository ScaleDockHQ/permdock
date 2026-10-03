---
"permdock": minor
---

`endpoint: false` on `createPermDock` from `permdock/next`, its `PermDockProvider` and the `permdock/react` provider makes the client snapshot-only. It never fetches, and a check the snapshot cannot answer (a closure, graph relation or period grant) is denied with the new reason `server-only`. The provider logs the first such permission once. The same reason replaces `opaque-condition` whenever the client store has no endpoint. `permdock doctor` PD044 warns when `usePermission` reads such a grant and the app has neither an `app/**/api/permdock/route.ts` using `permdockHandler` nor an `endpoint`. The Next.js Cache Components guide adds URL slugs (a public slug lookup ahead of the private snapshot, `notFound()` and `forbidden()`), snapshot-only mode, and a cross-origin endpoint section.
