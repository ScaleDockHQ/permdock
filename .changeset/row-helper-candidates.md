---
"permdock": minor
---

`rls.rowHelpers` also writes `permitted_<resource>_rows(p_permission text, p_ids text[])`, which answers for the candidate ids only and finds them through the id column before it runs the row checks, so its cost follows the number of ids instead of the size of the table. Inside it and inside `permitted_<resource>_row`, a one-link or `'parent'` `inherit()` asks the target's helper about the ids the checked rows point at, and a closure walk about those rows only, so a row check no longer reads the whole target table; the existing signatures and answers are unchanged. `rls generate` also compiles a one-link `inherit()` in a policy with no relation grant, which failed with "a related condition with link hops needs the policy resources".
