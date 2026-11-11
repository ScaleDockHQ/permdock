---
"permdock": patch
---

`permdock supabase inspect` builds the manifest of an `rls.authorize: 'database'` project without `supabase.hook` from its `rls.memberships` tables when it sets no `rls.membershipSources`. It failed with "supabase.hook.memberships needs at least one … source", and doctor PD094 skipped such a project.
