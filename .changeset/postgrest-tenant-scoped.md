---
"permdock": minor
---

`postgrestSources(client, { tenantScoped: true })` reads the memberships of the instance's `tenant` through `subject_for(p_user, p_tenant)` instead of every tenant's, and without a tenant it reads none. `SubjectRecord.tenant` and a fourth `tenant` argument on `SubjectCache.record` keep one cache entry per user and tenant, and `postgrestFixture` takes `tenantSubjects`. `permdock generate` rewrites no files and no data migration is needed.
