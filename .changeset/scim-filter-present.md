---
'permdock': patch
---

`permdock/scim`: the `pr` filter matches only a non-empty value, as RFC 7644 §3.4.2.2 requires. A group with no members no longer matches `members.value pr`, and an empty string no longer counts as present.
