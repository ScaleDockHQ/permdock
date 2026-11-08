---
"permdock": minor
---

Add `supabase.hook.refresh` (`'reuse'` default, `'full'`) and `supabase.hook.oauth` (`'full'` default, `'slim'`). A token refresh whose incoming `authz_ver` equals the current version keeps its `roles`, `memberships` and `team_ids` instead of reading them again, for sources without `expiresAt` or a scope suspension table; `oauth: 'slim'` returns empty `roles` and `memberships` for a token with a `client_id`. The generated `custom_access_token_hook` changes for every hook whose sources qualify: run `permdock generate --only supabaseHook` and apply the rewritten migration. No data migration is needed.
