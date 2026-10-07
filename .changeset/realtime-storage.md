---
"permdock": minor
---

`rls.realtime` and `rls.storage` (and `supabaseRls({ realtime, storage })`) make `permdock rls generate` write policies on `realtime.messages` for private channels and on `storage.objects` for buckets. A topic segment or a folder of the object name selects the scope instance, and the policies check the same permissions as your tables.
