---
"permdock": minor
---

`memoryVersionCache({ maxStaleMs })` shares authorization-version reads across instances through `claimsFirst(source, { onStale: 'reread', versions })`, so a page of ten Next.js private cache scopes makes at most one `authz_version_for` call. A token minted within `maxStaleMs` makes none. `getPermDock(…, { intent })` picks how fresh the version must be: `permdock/next` rendering and `GET`, `HEAD` and `OPTIONS` in the HTTP adapters use `read`, while `protectAction`, other methods and core `getPermDock` use `write`, which always reads live. Sources now receive a per-instance `memo`, and `subjectFromSupabase` and `permdock/jwt` map `iat` to `Subject.issuedAt`. Breaking: `postgrestSources` keeps no answers between calls, so create it once at module scope; outside an instance, each call now reads the database.
