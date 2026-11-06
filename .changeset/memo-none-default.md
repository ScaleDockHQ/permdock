---
"permdock": minor
---

`rls.memo` defaults to `'none'` in `database` mode on Supabase: the helpers write no `set_config` memo and are `language sql stable parallel safe`, and every `setof` helper carries `rows 10`. Set `rls.memo: 'permdock'` to keep the transaction-local memo. Breaking for a project that counted on the memo: regenerate and apply the helpers.
