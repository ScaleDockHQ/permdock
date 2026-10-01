---
'permdock': minor
---

The Supabase hook manifest gains `memberships` (each source's table and its user, scope, id, role, `within`, `via` and expiry columns or fixed values), `rls` (helper schema, `jwt` or `database` mode, tenant claim, scope id types, and each helper's arguments, return type and `execute` roles), `decidingColumns` (every `schema.table.column` a membership or an `attrs` claim is computed from, the same set PD028 checks) and `markers` (`{ hook: 'v1', grants: 'v1' }`), plus `$schema`. Its JSON Schema ships as `schemas/supabase-manifest-v1.json`. `permdock supabase inspect --out permdock.manifest.json` writes it, and `--check` exits 1 when the file's JSON differs. `inspect --out` used to override the hook path; the path now always comes from `supabase.hook.out`. `fromTable` and `fromJunction` expose their entry as `sql.manifest`.
