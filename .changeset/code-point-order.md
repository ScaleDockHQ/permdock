---
"permdock": patch
---

`assignableRoles`, `oauthScopes` permission lists and `permdock import` output sort keys by code point instead of `localeCompare`, so the order no longer depends on the ICU locale; mixed-case keys now list upper case first.
