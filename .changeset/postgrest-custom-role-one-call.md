---
"permdock": minor
---

`postgrestSources` takes `policy`. With it, `customRoles` reads nothing while every role the subject holds is declared, and `memberships.version` calls `subject_for` instead of `authz_version_for` when the token claims a custom role, so a custom-role token costs one call instead of two and a current token with declared roles keeps the version-only call. `MembershipSource.version` now receives the `roles` and `memberships` the token claims next to `id`.
