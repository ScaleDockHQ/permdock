---
"permdock": minor
---

Generated permission and row helpers carry `cost 1000`, and `parallel safe` where they use no `set_config` memo. `rls.memo: 'better-supabase'` keeps the `permdock.m.*` memo in `better_supabase.memo_get` and `memo_set`; the default `'permdock'` is unchanged.
