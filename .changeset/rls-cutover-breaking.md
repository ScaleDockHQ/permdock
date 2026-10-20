---
"permdock": minor
---

Breaking, `permdock rls generate`: every role, assignable or not, now gets the same `<grant key>@<level>` keys; `rls.customRoleWrites.roles.skip` and the backfill skip tenant rows only, so a global or shared role marked `is_system` is copied and cascaded (only a declared name excludes it) and stores no `scope_id`; and the backfill drops the stored level of a permission that has no levels instead of refusing it. Regenerate the helpers and rerun `--backfill-out`.
