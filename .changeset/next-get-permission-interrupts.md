---
"permdock": patch
---

`permdock/next`: `getPermission` lets Next.js interrupts (`redirect()`, `notFound()`, request-time bailouts) from `subject` or `tenant` pass through instead of turning them into a denial, and takes `{ tenant }` as a third argument. The server `PermDockProvider` no longer replaces a failed snapshot with an empty one: hooks answer `server-only`, and with `suspend` the error reaches the nearest error boundary. Instances with a factory `onDenied` are frozen, and their `tenant()`, `team()` and `derive()` keep the handler.
