---
"permdock": minor
---

`defineSeeds` data is emitted by the RLS plugin: default roles become an idempotent `role_permissions` migration, and fixtures become `supabase/seeds/permdock.sql`. `permdock/testing` adds `memorySources` and `applySeeds`. Doctor PD097 fails when fixture data is in a migration or schema file, and prints the `[db.seed]` `sql_paths` line to add. PermDock does not edit `config.toml`.
