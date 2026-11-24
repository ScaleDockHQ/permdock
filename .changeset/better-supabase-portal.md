---
"permdock": minor
---

`authorizationProvider` fills `portalParties` and `portalSubjects` from a child scope whose memberships name `via`, `teamIdsOf` from the one child scope without `via`, `versions` from the hook's `authz_version_for`, and `wildcards: 'none'` when no catalog key holds a `*`.
