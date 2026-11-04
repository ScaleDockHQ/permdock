---
"permdock": minor
---

`permitted_<resource>_row` is faster in policies. A policy calls it once per row and Postgres cannot inline a `security definer` function, so every call used to rerun the grant lookups of the permission's arm. On Supabase with database authorization the row helper now runs those row-independent lookups once per statement and keeps their answers in one transaction-local setting, `permdock.m.<resource>.r<bucket>`, keyed like the scope memo by user, permission, `authz_ver`, memo generation, statement and token. Later calls in the statement check only the row's columns, so the cost per row no longer grows with the number of grants. The row-valued and the per-id forms both become `language plpgsql volatile` with the same signatures and grants, and share the memo. Answers are unchanged, `insert ... returning` still sees the new row, and the `jwt` mode and the `guc` and `neon` dialects keep the `language sql` form.

The memo generation now also bumps on writes to the membership source tables and the global roles table the helpers read, and, with row helpers, to the tables the graph relation helpers read. Each gets a statement-level `permdock_memo_generation` trigger and a `TRUNCATE` trigger, so a function that adds a membership or a share and then reads in the same statement sees the change, with or without the token hook's version triggers.
