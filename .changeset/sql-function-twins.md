---
'permdock': minor
'@permdock/cli': minor
'@permdock/testing': patch
---

Add `sqlFunction` conditions with an in-memory twin so SQL-authority RLS helpers stay portable. `permdock rls` generates the call, imports mapped functions via `pgsql-parser`, and `verify --db` proves the twin. PermDock Cloud must accept the new node in snapshots and decision events.
