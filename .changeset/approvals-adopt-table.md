---
"permdock": minor
---

`rls.approvals` accepts `{ table, token?, body?, mirror? }` to put the generated approval store on a table the app already has. `rls generate` adds the token and body columns when missing, indexes them and writes the same `permdock_approval_*` functions, so `supabaseApprovalStore` works unchanged. The functions read every field from the body, skip the app's rows that have none, and copy the fields `mirror` names into the app's columns on each write, converted to their types. The table's grants and policies stay the app's.
