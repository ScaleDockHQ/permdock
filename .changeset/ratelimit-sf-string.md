---
"permdock": patch
---

`RateLimit` and `RateLimit-Policy` now serialise the policy name as a valid RFC 9651 sf-string: `"` and `\` are escaped instead of dropped, and a role name outside printable ASCII is percent-encoded as UTF-8.
