---
"permdock": minor
---

Breaking: `supabase hook generate`, `powersync generate`, `scim generate`, `openapi emit` and `gen` are removed. Run `permdock generate`, with `--only supabaseHook`, `--only powersync`, `--only scim` or `--only openapi` for one plugin. `gen` output is part of `permdock generate` when `gen` is set in the config. Each old command fails with one suggestion.
