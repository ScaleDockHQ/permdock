---
"permdock": minor
---

`resource(…, { orderedLevels: true })` marks levels declared from narrowest to widest: a holder of a level may hand out every earlier level in `assignableLevels`, `assignableRoles`, the snapshot and the SQL custom-role write functions. Decisions are unchanged, and the catalog marks such permissions with `orderedLevels: true`. `permdock_custom_role_guard` and `permdock_custom_role_beyond` are now documented as stable for an app's own `security definer` write path.
