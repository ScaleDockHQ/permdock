---
"permdock": minor
---

`rls.approvals` on an adopted table takes `open: 'attach'` and `schema`. With `open: 'attach'`, `permdock_approval_open` attaches the request to the row the app inserted with the decision's token, so tables with required columns only the app can fill work with `supabaseApprovalStore`; with no such row it raises `P0002` and the open fails. `schema` writes the store functions into another schema, such as `public` when the helper schema is not exposed, so `supabaseApprovalStore(client, { schema })` reaches them without wrapper functions.
