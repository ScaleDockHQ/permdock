---
"permdock": minor
---

Breaking: `permdock_has` and `permitted_<scope>_ids` are stable. Their memo key is the user, the grant, `authz_ver` and the memo generation. It no longer includes `statement_timestamp()` or a hash of the whole JWT. The memo write is `permdock_memo_put`, which those helpers do not call.
