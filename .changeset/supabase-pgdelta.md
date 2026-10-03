---
'permdock': patch
---

Supabase declarative schemas on pg-delta. With `[experimental.pgdelta] enabled = true` in `supabase/config.toml`, `permdock rls generate --split` without `--out` writes pg-delta's per-schema, unnumbered layout under `declarative_schema_path`: `permdock/helpers.sql`, `permdock/indexes.sql`, `public/policies/permdock.sql` and `permdock/functions/custom_access_token_hook.sql`. `permdock supabase hook generate` without `--out` writes the same hook path. pg-delta keeps grants, so the hook keeps its `supabase_auth_admin` grants. It rejects data in a schema file, so the `helpers` part now needs the `seeds` part with `--seeds-out`. Doctor PD042 and PD043 are off under pg-delta. The token hook casts `user_id` to `uuid` once, so `supabase db lint` reports no implicit casts.
