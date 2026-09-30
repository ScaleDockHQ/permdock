---
'permdock': minor
---

`permdock rls verify --introspect --db <url>` compares the live database with what `rls generate` would write: policies (by name, command, permissive or restrictive, and roles), row level security on each table, the `anon` and `authenticated` grants, and whether each helper is still `security definer` with `search_path = ''`. It prints one line per difference and exits `1`, so a hand-written permissive policy or a missing grant shows up before a user finds it.
