---
"permdock": patch
---

Doctor, `permdock supabase inspect` and `permdock generate` read the output paths from the `rls()`, `supabaseHook()` and `supabase()` plugins. The plugins fold their `out`, `split` and hook `out` into `rls.out`, `rls.split` and `supabase.hook.out`, so PD039 and PD064 find the generated helpers, the manifest's `hook.out` names the file the hook plugin writes, and `rls()` with `seeds.out` uses `rls.split` from the config instead of failing with "--seeds-out needs --split". `definePlugin` takes an optional `config` member for this.
