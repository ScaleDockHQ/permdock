---
"permdock": minor
---

Breaking: a Supabase manifest whose row helper omits `idType` is refused. Run `permdock generate`. PermDock no longer reads a missing `idType` as `uuid`. `platformRoles` and `personas` are fields of the better-supabase 0.53 provider.
