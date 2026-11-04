---
"permdock": minor
---

Add the `SubjectCache` extension interface, `memorySubjectCache` and `testSubjectCache`, and a `subjects` option on `postgrestSources` and `permdockFor`. `postgrestSources().record()` reads the cache before `subject_for` at the authorization version the instance resolved, and refuses to seed a record below a version already seen.
