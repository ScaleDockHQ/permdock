---
"permdock": minor
---

`rls.realtime` and `rls.storage` (and `supabaseRls({ realtime, storage })`) make `permdock rls generate` write policies on `realtime.messages` for private channels and on `storage.objects` for buckets. A topic segment or a folder of the object name selects the scope instance, and the policies call `permitted_<scope>_ids_by_permission('<key>')`, so they count only the allows without a row condition, minus any deny, and a permission split into `#n` grant keys still matches. For a permission that also has a relationship grant or a `where`, `rls generate` warns that its topic or folder admits only the instances its role allows reach. Doctor check PD037, `rls verify --db` and `rls verify --introspect` no longer flag a policy that calls the permission-key forms, which never grant more than the application does, and the PD037 fix names them.
