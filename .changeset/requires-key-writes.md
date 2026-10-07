---
"permdock": minor
---

Security fix: under `rls.apiKeys`, an allow with `requires` passed the generated key check when the `api_key` claim named any one of its required keys, so a read-only key scoped to `file.read` could update rows through an editor share whose `node.update` grant requires `file.read`, and reached grants with `requires: [file.read, file.update]` that its scopes did not cover. The policy now checks every required key and, unless the granted permission is read-only (`meta.readOnly`, or the `read` and `list` actions) and the allow is not a role grant, the granted key as well. `can()` and `decide()` apply the same rule to OAuth clients and API keys, so a delegated caller whose scopes miss the granted permission of a write is `not-delegated` there too. Regenerate the RLS SQL with `permdock rls generate`.
