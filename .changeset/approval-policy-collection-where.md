---
"permdock": minor
---

An `ApprovalPolicy` entry with `where` on a collection permission no longer loads silently and never matches: it is refused like any other invalid entry, so the source denies with `approval-policy-unavailable` until the entry uses `check`. The new `validateApprovalPolicy(policy, entry)` returns `{ ok: false, problem }` (`unknown-permission`, `invalid`, `where-on-collection`, `stale-on-without-version`) so an application can refuse a bad entry when it is saved.
