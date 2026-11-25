---
"permdock": minor
---

`permdock rls measure --as <user>` runs requests as a user against the app's database and prints the version reads per request, the helper times from `pg_stat_user_functions` and `pg_stat_statements`, and the share of tenant tokens that get a share key.
