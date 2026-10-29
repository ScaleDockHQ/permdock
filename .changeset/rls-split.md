---
"permdock": patch
---

`rls.split` in the config takes the `--split` parts, and the flag overrides it. `permdock supabase inspect`, `supabase hook generate` and doctor PD039 follow the split `hook` part of `rls.out`, and PD039 also scans pg-delta's helpers file, so a split or declarative setup no longer reports a missing hook or helper.
