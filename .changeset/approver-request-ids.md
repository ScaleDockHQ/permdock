---
"permdock": minor
---

`rls.approvals` writes `permdock_approver_request_ids(p_requests, p_kinds, p_current)`, the approver check as a set: the ids of the requests the signed-in user may approve, each answered as `permdock_is_approver` answers it, with the caller's permission, manager and cover facts read once per call instead of once per request. `permdock supabase inspect` lists it in the manifest. The per-request `permdock_is_approver` is unchanged.
