---
"permdock": minor
---

`rls.realtime` and `rls.storage` policies now call `permitted_<scope>_ids_by_permission('<key>')` instead of `permitted_<scope>_ids('<key>')`, so they count only the allows without a row condition, minus any deny, and a permission split into `#n` grant keys still matches. A permission that also has a relationship grant or a `where` is no longer refused: `rls generate` warns that its topic or folder admits only the instances its role allows reach. Doctor PD037, `rls verify --db` and `rls verify --introspect` no longer flag the permission-key forms, which never grant more than the application does, and the PD037 fix names them. Regenerate the policies; the example carries a migration that recreates them.
