---
"permdock": patch
---

`permdock rls generate` follows the Postgres and Splinter rules its docs cite:

- One permissive policy per table, command and database role. `anyone()` grants are ORed into the `authenticated` policy and get their own `TO anon` policy, so Splinter's `multiple_permissive_policies` lint stays quiet.
- The `neon` dialect targets Neon's `anonymous` role instead of `anon`.
- The `guc` dialect wraps `current_setting(...)` in `(select ...)`, so each setting is read once per statement.
- `rls import` reads the wrapped form back.
