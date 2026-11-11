---
"permdock": patch
---

With `rls.memo`, `permitted_<resource>_rows(p_permission)` and its `p_tenant` form keep their ids in the same transaction-local memo as `permitted_<scope>_ids`, keyed and invalidated the same way, so the policies that read a row set in one statement share one evaluation instead of evaluating it once per reference. The resource table and the tables the set reads get the memo generation trigger. A set above 10,000 ids is not stored. The answers do not change.
