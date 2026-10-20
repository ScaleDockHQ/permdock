---
"permdock": minor
---

`permdock supabase inspect --out` writes the manifest in `rls.authorize: 'database'` mode without `supabase.hook`, leaving out `hook`, `budget`, `claims`, `authzVersion` and `memberships`; `parseSupabaseManifest` returns `SupabaseManifest`, and `authorizationProvider` leaves `tokenHook` unset for it.
