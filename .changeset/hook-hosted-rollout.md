---
"permdock": minor
---

Doctor `PD074` warns when `supabase.hook` is set and `supabase/config.toml` does not enable `[auth.hook.custom_access_token]` with the generated function's `uri`. `permdock supabase inspect` adds `managementApi` (`hook_custom_access_token_enabled`, `hook_custom_access_token_uri`, `jwt_exp`) to its output and to the manifest file, and the manifest schema gains that optional field.
