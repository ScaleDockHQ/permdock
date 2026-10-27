---
"permdock": minor
---

`rls.rowHelpers` now writes `permitted_<resource>_rows_for(p_user, p_permission, p_ids text[], p_claims jsonb default '{}')` beside the existing `_for` form, outside the `neon` dialect. It answers which of the candidate ids `p_user` may act on with the permission, the same answer `permitted_<resource>_rows(p_permission, p_ids)` gives when `p_user` is the caller, so a `security definer` function serving a request with no signed-in user, such as a share-link calendar feed, can check a few stored rows against the link creator's access without reading the whole table. Like the other `_for` helpers, `execute` is revoked from `public`, `anon` and `authenticated`. A call that passes claims as an untyped third argument now matches both forms; cast it (`'{...}'::jsonb`) or pass `p_claims` by name. Regenerate the RLS SQL to pick this up.
