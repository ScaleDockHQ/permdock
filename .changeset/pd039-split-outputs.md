---
"permdock": patch
---

Doctor PD039 and `supabase hook generate` now find helpers written with `rls generate --split`. They read the `helpers` part of an `rls.out` path with a `{part}` placeholder, and the SQL files in the hook file's folder, besides `rls.out` and the migration folders. Before, a project that kept the split path in a script got a false warning that the helper schema had no helpers.
