---
"permdock": patch
---

`grant_keys` and `permitted_<resource>_match` are now PL/pgSQL. A `can_<resource>(row, permission)` policy calls the match once per row, and Postgres never inlines a `security definer` SQL function, so it parsed and planned the body and the permission map again for each row. PL/pgSQL keeps the parsed statements for the session. In an adopting app, a list of 46 rows behind a `can_<resource>` select policy drops from about 39 ms to 7 ms, and a single-row read drops from 1.7 ms to 1.0 ms. Run `permdock generate` to pick up the new helpers.
