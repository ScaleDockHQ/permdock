---
"permdock": minor
---

`supabaseApprovalStore` takes a `beforeOpen` hook that runs on every `create`, before the request is stored, with the request. Over an adopted table with `rls.approvals.open: 'attach'`, insert the app's own row holding `request.token` there instead of wrapping `create`; a throw fails the open before anything is stored, and a repeated ask runs it again, so ignore a conflict on the token. The read-only actors docs now name the `write-unguarded:<table>:<command>` finding id that `rls verify --introspect --helpers-only` reports for a hand-written write policy without `permdock_actor_may_write()`.
