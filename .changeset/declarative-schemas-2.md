---
"permdock": minor
---

`rls generate --split` and `supabase hook generate` now write for Declarative Schemas 2.0 (pg-delta, `supabase db schema declarative sync`) unless `supabase/config.toml` sets `[experimental.pgdelta] enabled = false` or the project sets `supabase.schemas: 'migra' | 'migrations'` or `--schemas`. `--grants-out` is refused outside `migra`, and `helpers` without `seeds` and `--seeds-out` is refused under `migra`. Doctor PD068 fails when `config.toml` does not turn pg-delta on. PD069 warns about migra leftovers. The manifest's new `hook.schemas` field picks the better-supabase `grantsCommand`.
