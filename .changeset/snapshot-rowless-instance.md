---
"permdock": patch
---

A snapshot-backed instance (`fromSnapshot`) now answers an instance action checked without a row the way the server does: from the first-scope memberships of the active tenant, or from the instance `team(id)` selected. It used to deny every such check on a partitioned resource with `tenant-mismatch` or `scope`, so a page guard that passed on the server failed on the client.
