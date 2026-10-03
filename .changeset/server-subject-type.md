---
"permdock": patch
---

The `subject` option of `permdock/server` and every adapter built on it is now typed to return a full `Subject` or `null` as well as the policy's user, matching what the kernel already accepted at runtime.
