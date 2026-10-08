---
"permdock": minor
---

A single membership can be suspended while the user's other memberships and sign-in stay intact. `disabledAt` names a nullable timestamp column on an `rls.memberships` table, on `fromTable` (`columns.disabledAt`) and on `fromJunction`; a row with a value keeps its role, and only its permissions drop. `rls.suspension.memberships.keep` lists what a suspended membership still holds, as a scope's `keep` does. The `database` mode helpers, the inline `memberOf` checks, `authorize()`, the token hook, `subject_for`, `members_of` and the in-process sources honour the column, the `jwt` mode helpers and `authorize()` honour the `keep` of a claim membership, and the holder-count triggers and `permdock_can_assign` count no suspended membership. The manifest carries `memberships[].disabledAt` and `rls.suspension.memberships.keep`, and PD061 lists the kept keys.
