---
"permdock": minor
---

A tenant-scoped check on a subject with no active tenant now denies with the new reason `no-tenant`. A requested tenant the subject does not hold still denies with `no-membership`. PermDock Cloud and other consumers that switch on the closed reason list handle `no-tenant`.
