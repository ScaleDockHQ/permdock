---
"permdock": patch
---

`postgrestSources` no longer hangs when several tenants' custom-role versions are read in the same tick through one `SourceMemo`, as `permdock.derive({ customRoles })` does since 0.36.0 for a user with custom roles in several tenants. Every queued version read is now sent and settles: the user's read and the first tenant read for that user leave as one combined call, and each other read leaves on its own.
