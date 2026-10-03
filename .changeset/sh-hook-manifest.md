---
"permdock": minor
---

The generated Supabase hook starts with a stable `-- permdock:hook v1 schema=… tenant=… budget=… claims=…` line, and `supabase hook generate --check` names the marker fields that drifted. `permdock supabase inspect [--json]` prints the `version: 1` manifest of the hook and SQL helpers (helper names, tenant claim, budget and its measure, claims written, `authz_ver`); `permdock/supabase` exports the `SupabaseHookManifest` type and `permdock/testing` exports `supabaseHookManifestFixture`.
