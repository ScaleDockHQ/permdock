---
"permdock": minor
---

`PermDockProvider` from `permdock/next` takes `snapshot`, a promise from the app's `'use cache: private'` loader around `getSnapshot`, so a prefetch carries the snapshot. With `snapshot` the provider builds none itself, and `include` or `tenants` next to it is a type error; without it the provider behaves as before.
