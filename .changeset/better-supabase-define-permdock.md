---
"permdock": minor
---

`permdock/better-supabase` exports `definePermDock`. It owns the version, instance and subject caches, loads `client()` on first use, and adds `.server`, `.authorizer` and `.next`. `permdock/app` still has no `.next` or `.authorizer`.
