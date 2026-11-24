---
"permdock": minor
---

`permdock rls verify --shadow <url|stack>` loads the declarative schema directory into a shadow database with `@supabase/pg-delta` and reports each policy expression, function body or grant of a PermDock object that differs from the live database.
