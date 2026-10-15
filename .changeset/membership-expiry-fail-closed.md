---
"permdock": patch
---

A membership whose `expiresAt` is not Unix seconds no longer lives forever. An RFC 3339 string (how a `timestamptz` arrives as JSON), a `Date` or an `Instant` is now converted to seconds, `null` still never expires, and any other value, `NaN` and `Infinity` included, fails closed: a membership from a subject or a `MembershipSource` is dropped, and one from a token's `memberships` claim is treated as expired.
