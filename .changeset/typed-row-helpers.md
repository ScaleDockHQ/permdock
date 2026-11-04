---
"permdock": minor
---

Row helpers use the resource's id type: `permitted_<resource>_rows`, `_rows_for` and the new `permitted_<resource>_row(p_id, permission)` take and return `uuid` on the `supabase` dialect and `text` on `neon`; set `rls.idTypes` per resource. This changes the generated signatures: regenerate, drop the old `text[]` overloads, and remove `::text` casts around calls (doctor `PD088`). Root-scope keys start with a tenant prefilter, and `PD089` flags `id in (select permitted_*_rows(…))` where one id is known.
