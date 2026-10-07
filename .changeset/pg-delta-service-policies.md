---
"permdock": patch
---

Under pg-delta, `rls generate --split` no longer writes the `rls.realtime` and `rls.storage` policies into the declarative `policies` part. The Realtime and Storage services create `realtime.messages` and `storage.objects`, so pg-delta's shadow database, and a local stack with either service off, has neither table and `supabase db schema declarative sync` failed with `relation "realtime.messages" does not exist`. The policies now go in the `--seeds-out` migration, each in a `do` block that creates it only where `to_regclass` finds its table. With those policies, the `policies` part under pg-delta needs the `seeds` part with `--seeds-out`. Other layouts are unchanged.
