---
"permdock": minor
---

`rls generate --grants-out` now works with the `helpers` part. It moves the helpers' grants and revokes (schema usage, the helper tables, every helper function) out of that part, together with `alter view <schema>.permdock_ceiling set (security_invoker = true)`, into the grants file, because `supabase db diff` drops all of them. With the `hook` part as well, the file holds the helpers' statements first and the hook's after them. Projects that appended these statements to a migration by hand can generate them instead.
