---
"permdock": minor
---

`permdock/supabase` exports `definePermDock` and `subjectFromSupabaseClient`, and `permdock/supabase/middleware`'s `createPermDock` accepts that definition with `subject` optional. `permdock/cli/plugins/supabase` adds `supabase()`, which writes the RLS SQL, the hook SQL and `permdock.manifest.json`; it conflicts with `rls()` and `supabaseHook()`.
