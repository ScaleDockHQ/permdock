---
"permdock": minor
---

The CLI reads `supabase/config.json` and `config.jsonc` as well as `config.toml`, resolves `env(NAME)` values (PD045 names an unset one), and `doctor`, `generate`, `supabase hook generate`, `rls` and `powersync verify` take `--local [--stack <name>]` to connect to the local Supabase stack. Doctor PD068 now fires only when the config sets `[experimental.pgdelta] enabled = false`, and the new PD136 warns about a Supabase CLI older than 3.2.0.
