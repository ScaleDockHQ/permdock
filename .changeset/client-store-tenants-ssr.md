---
"permdock": minor
---

`snapshot({ tenants })` takes a list of tenant ids as well as `"all"`, and drops a tenant without a membership. Client providers take `fetchSnapshot({ tenant })`, which answers `refresh()` without a URL. `subjectMembershipSource(subject)` builds a `MembershipSource` from a subject's memberships. `PermDockProvider` with a `snapshotPromise` renders a settled promise's grants on the server, and hydrating components keep reading the server's view until the store updates.
