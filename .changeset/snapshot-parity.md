---
"permdock": patch
---

A snapshot now carries `ids`, the row id field of each resource whose `id` option is not `id`. A client `can` on a membership held on one row then answers as the server does, where it used to deny. The client `can()` returns `false` instead of throwing when reading the row throws. The plan seats a client counts now use the policy's scopes.
