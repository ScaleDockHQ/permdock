---
'permdock': patch
---

`PermDockProvider` with `snapshotPromise` no longer reads the clock while the promise is pending, so a synchronous Next.js layout that passes the promise prerenders under Cache Components instead of failing with `blocking-prerender-current-time-client`. `authorizeSql` qualifies a bare membership table with `public`, because the function runs with `search_path = ''` and an unqualified name did not resolve.
