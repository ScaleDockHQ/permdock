---
"permdock": patch
---

`rls generate` no longer lets a member of one organization read another organization's rows. A `memberOf` check over a membership table compared `m.<column> = "<row field>"` inside its subquery, and when the membership table had a column of the same name (`org_id`, `project_id`, `id`), Postgres compared the membership column with itself. The check is now `"<row field>" in (select m.<column> from <table> m where …)`, and the suspension check is `coalesce(<id> in (select s.<id> from <table> s where …), false)`. Regenerate and apply your RLS.
