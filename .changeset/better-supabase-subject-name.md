---
"permdock": patch
---

`authorizationProvider` writes `functions.subject` as `permdock.permdock_subject`, the `schema.function` name better-supabase calls with `()`. It wrote the full call before, so better-supabase 0.58.3 and later generated `permdock.permdock_subject()()` in `bootstrap_app`, which failed on every call.
