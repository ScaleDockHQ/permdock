---
"permdock": minor
---

`permdock/better-supabase` exports `definePermDock`. It owns the version, instance and subject caches, loads `client()` on first use, and adds `.server`, `.fromClient`, `.authorizer` and `.next`. It takes the `permdock/supabase` `subject` and `api` options, and `createPermDock(definition)` from `permdock/supabase/middleware` accepts it and reads the same caches. PD100 reports a source file that imports `definePermDock` from `permdock/supabase` while a better-supabase config exists. `permdock/app` still has no `.next` or `.authorizer`.
